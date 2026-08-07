// Murmur's macOS glue (PLAN §4).
//
// Everything Electron cannot do, in one small, defensive N-API module:
//
//   * a CGEventTap for the configured hotkey, including `fn`
//     (which only ever arrives as a flagsChanged event);
//   * synthetic ⌘V for text insertion, plus an AXUIElement fallback;
//   * secure-input detection, so we never type into a password field;
//   * frontmost-application bundle id, for the tone category;
//   * permission checks, prompts and System Settings deep links.
//
// ## Design rules
//
// This code runs inside the user's login session with Input Monitoring and
// Accessibility granted. That is a lot of trust, so it is written to be boring:
//
//  1. **Only for the hotkey.** The tap callback compares the event against the
//     configured key and returns immediately for everything else. No key
//     content is copied, buffered, logged or forwarded — PLAN §10.5 states
//     that in-app, and this is the code a reviewer checks.
//  2. **Suppression is targeted.** The tap swallows an event only when the
//     event *is* the hotkey: a custom ordinary-key binding (holding it must
//     not type a character), and the bare fn transition (a double-press is
//     also Apple Dictation's trigger). The right-hand modifiers are never
//     suppressed, and fn+<key> chords pass through untouched.
//  3. **Never block the tap thread.** The callback does the minimum and hands
//     off through a thread-safe function; JS runs on the main thread. A full
//     queue drops the edge rather than stalling every keystroke on the system.
//  4. **Fail soft.** Every entry point returns a value rather than throwing
//     for a foreseeable condition; the JS wrapper turns a missing capability
//     into a status.
//  5. **Clean teardown.** `stopHotkeyListener` disables the tap, removes the
//     run-loop source, releases both and releases the TSFN — and an env cleanup
//     hook does it again if the process is torn down first.
//
// It cannot be compiled anywhere but macOS, and it is compiled on macOS CI.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <Foundation/Foundation.h>

#include <napi.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

namespace {

// The build's target architecture, reported by platformInfo().
constexpr const char* kArch =
#if defined(__aarch64__) || defined(__arm64__)
    "arm64";
#elif defined(__x86_64__)
    "x64";
#else
    "unknown";
#endif

// ---------------------------------------------------------------------------
// Hotkey configuration
// ---------------------------------------------------------------------------

// Which physical key Murmur watches. Mirrors HotkeyKey in @murmur/shared.
enum class HotkeyKind {
  Fn,        // arrives via flagsChanged / kCGEventFlagMaskSecondaryFn
  RightCmd,  // key code 54
  RightOpt,  // key code 61
  Custom,    // an explicit virtual key code
};

struct HotkeyConfig {
  HotkeyKind kind = HotkeyKind::Fn;
  int64_t customKeyCode = -1;
  bool doubleTapHandsFree = true;
};

// Two presses inside this window are a double-tap. Mirrors HOTKEY.doubleTapMs
// on the JS side; duplicated because the tap thread must decide immediately.
constexpr double kDoubleTapSeconds = 0.35;

// ---------------------------------------------------------------------------
// Module state
//
// Touched from two threads — the CFRunLoop the tap lives on and the JS thread —
// so the flags are atomic and the structural bits are only mutated while the
// tap is stopped.
// ---------------------------------------------------------------------------

struct HotkeyEventPayload {
  int type;  // 0 = down, 1 = up, 2 = doubleTap
  double timestamp;
};

CFMachPortRef gEventTap = nullptr;
CFRunLoopSourceRef gRunLoopSource = nullptr;
CFRunLoopRef gRunLoop = nullptr;
// The tap's own thread. Electron's main CFRunLoop is exactly the loop that
// goes busy during a dictation, and a starved tap gets disabled by the OS for
// slowness — which is how a release edge silently vanished mid-utterance. A
// dedicated loop has nothing else to do and never starves.
std::thread gTapThread;
std::atomic<bool> gTapThreadReady{false};
Napi::ThreadSafeFunction gCallback;
std::atomic<bool> gListening{false};
// True between hotkey-down and hotkey-up.
std::atomic<bool> gHotkeyDown{false};
HotkeyConfig gConfig;
double gLastDownAt = 0.0;
// When the current press began, so the up edge can classify it as tap or hold.
double gDownAt = 0.0;
// True when the previous press was a quick tap (down→up under kTapMaxSeconds).
// A double-tap is tap-then-tap; a long dictation hold followed by a quick
// press must never latch hands-free.
bool gLastPressWasTap = false;

// A press this short is a tap; longer is a hold. Generous enough for a
// deliberate double-tap, short enough that no dictation hold qualifies.
constexpr double kTapMaxSeconds = 0.30;

double NowSeconds() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// Push one hotkey edge to JS. Safe to call from the tap thread.
void EmitHotkeyEvent(int type, double timestamp) {
  if (!gListening.load()) return;

  HotkeyEventPayload* payload = new HotkeyEventPayload{type, timestamp};
  napi_status status = gCallback.NonBlockingCall(
      payload, [](Napi::Env env, Napi::Function callback, HotkeyEventPayload* data) {
        Napi::Object event = Napi::Object::New(env);
        const char* name = data->type == 0 ? "down" : (data->type == 1 ? "up" : "doubleTap");
        event.Set("type", Napi::String::New(env, name));
        event.Set("timestamp", Napi::Number::New(env, data->timestamp * 1000.0));
        delete data;
        callback.Call({event});
      });

  // Queue full, or the TSFN is closing: drop the edge rather than block the
  // event tap, which would stall every keystroke on the system.
  if (status != napi_ok) delete payload;
}

// ---------------------------------------------------------------------------
// The event tap
// ---------------------------------------------------------------------------

// Is `fn` currently held, per these flags?
bool FnIsDown(CGEventFlags flags) { return (flags & kCGEventFlagMaskSecondaryFn) != 0; }

// Does this event carry the configured non-`fn` key?
bool MatchesKeyCode(CGEventRef event) {
  const int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  switch (gConfig.kind) {
    case HotkeyKind::RightCmd:
      return keyCode == static_cast<int64_t>(kVK_RightCommand);
    case HotkeyKind::RightOpt:
      return keyCode == static_cast<int64_t>(kVK_RightOption);
    case HotkeyKind::Custom:
      return gConfig.customKeyCode >= 0 && keyCode == gConfig.customKeyCode;
    case HotkeyKind::Fn:
      return false;
  }
  return false;
}

// True when the modifier the config names is held, per `flags`.
bool ModifierHeld(CGEventFlags flags) {
  switch (gConfig.kind) {
    case HotkeyKind::Fn:
      return FnIsDown(flags);
    case HotkeyKind::RightCmd:
      return (flags & kCGEventFlagMaskCommand) != 0;
    case HotkeyKind::RightOpt:
      return (flags & kCGEventFlagMaskAlternate) != 0;
    case HotkeyKind::Custom:
      return false;
  }
  return false;
}

void HandleEdge(bool down) {
  const double now = NowSeconds();

  if (down) {
    if (gHotkeyDown.exchange(true)) return;  // auto-repeat; already down

    // Tap-then-tap only. Requiring the *previous* press to have been a quick
    // tap is what stops a long dictation hold, released and quickly followed
    // by a new press, from reading as a double-tap.
    const bool isDoubleTap = gConfig.doubleTapHandsFree && gLastPressWasTap &&
                             gLastDownAt > 0.0 && (now - gLastDownAt) <= kDoubleTapSeconds;
    gLastDownAt = now;
    gDownAt = now;
    gLastPressWasTap = false;  // decided on the up edge
    EmitHotkeyEvent(isDoubleTap ? 2 : 0, now);
    return;
  }

  if (!gHotkeyDown.exchange(false)) return;  // spurious up
  gLastPressWasTap = gDownAt > 0.0 && (now - gDownAt) <= kTapMaxSeconds;
  EmitHotkeyEvent(1, now);
}

/**
 * Stamped on every event we post ourselves.
 *
 * The paste used to be posted from a private event source, which kept it out
 * of our own tap for free — but a private source is also why the Command
 * modifier never reached the target app (see SendPasteShortcut). Posting from
 * the combined session state fixes that and makes our synthetic keystrokes
 * visible to our own tap, so they need a way to be recognised: without one, a
 * user who had bound `v` as a custom hotkey would have their own paste
 * swallowed by the tap that is meant to be watching for their key.
 */
constexpr int64_t kMurmurSyntheticMarker = 0x4D524D52;  // 'MRMR'

void MarkSynthetic(CGEventRef event) {
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, kMurmurSyntheticMarker);
}

bool IsSynthetic(CGEventRef event) {
  return CGEventGetIntegerValueField(event, kCGEventSourceUserData) == kMurmurSyntheticMarker;
}

CGEventRef TapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* refcon) {
  (void)proxy;
  (void)refcon;

  // Our own synthetic paste, on its way to the target app. Never a hotkey edge,
  // and never ours to suppress.
  if (IsSynthetic(event)) return event;

  // The OS disables a tap that takes too long, or when access is revoked.
  // Re-enable rather than silently losing the hotkey for the rest of the session.
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (gEventTap != nullptr) CGEventTapEnable(gEventTap, true);
    return event;
  }

  if (!gListening.load()) return event;

  if (gConfig.kind == HotkeyKind::Fn) {
    // `fn` never produces keyDown/keyUp — only a flags change.
    if (type != kCGEventFlagsChanged) return event;
    // Only the fn/globe key itself. Arrow and function-row keys live on the fn
    // plane and emit flagsChanged events carrying the SecondaryFn mask as a
    // side effect — without the key-code check, two arrow presses inside
    // 350 ms read as an fn double-tap and latch hands-free out of nowhere,
    // after which a real hold "never stops" because hands-free ignores the
    // release by design.
    const int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (keyCode != kVK_Function) return event;
    HandleEdge(FnIsDown(CGEventGetFlags(event)));
    // Consume the bare fn transition: macOS's own globe-key actions — the
    // emoji picker, input-source switching and above all "press fn twice to
    // start Dictation" — must not fire alongside Murmur's, and a double-tap
    // (our hands-free latch) is exactly Apple Dictation's trigger. fn+<key>
    // chords are untouched: those arrive as their own key events carrying the
    // fn flag, and hardware modifier state lives upstream of a session tap.
    return nullptr;
  }

  if (gConfig.kind == HotkeyKind::RightCmd || gConfig.kind == HotkeyKind::RightOpt) {
    // The right-hand modifiers also arrive as flagsChanged, but with a key code
    // that distinguishes them from their left-hand twins.
    if (type != kCGEventFlagsChanged) return event;
    if (!MatchesKeyCode(event)) return event;
    HandleEdge(ModifierHeld(CGEventGetFlags(event)));
    return event;
  }

  // Custom: an ordinary key. This is the one case worth suppressing — holding
  // it must not also type a character or fire the app's shortcut (PLAN §4).
  if (type != kCGEventKeyDown && type != kCGEventKeyUp) return event;
  if (!MatchesKeyCode(event)) return event;
  HandleEdge(type == kCGEventKeyDown);
  return nullptr;  // targeted suppression, this key only
}

void TearDownTap() {
  gListening.store(false);
  gHotkeyDown.store(false);

  // Stop the tap thread's loop first: the source must not be torn out from
  // under a loop that is still running it. Wait for the entry observer's
  // readiness signal so the stop cannot land before the loop starts (a lost
  // stop is a join that never returns).
  if (gTapThread.joinable()) {
    for (int i = 0; i < 2000 && !gTapThreadReady.load(); i += 1) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (gRunLoop != nullptr) CFRunLoopStop(gRunLoop);
    gTapThread.join();
  }

  if (gRunLoopSource != nullptr) {
    // Deliberately NOT CFRunLoopRemoveSource: the dead thread's loop purged
    // its own sources in its finalizer, and removing from it here was a
    // proven use-after-free (crash reproduced under both the system allocator
    // and libgmalloc). Releasing our reference is all that remains to do.
    CFRelease(gRunLoopSource);
    gRunLoopSource = nullptr;
  }

  if (gEventTap != nullptr) {
    CGEventTapEnable(gEventTap, false);
    CFRelease(gEventTap);
    gEventTap = nullptr;
  }

  if (gRunLoop != nullptr) {
    CFRelease(gRunLoop);  // pairs with the CFRetain on the tap thread
    gRunLoop = nullptr;
  }
  gTapThreadReady.store(false);
  gLastDownAt = 0.0;
  gDownAt = 0.0;
  gLastPressWasTap = false;
}

void ReleaseCallback() {
  if (gCallback) {
    gCallback.Release();
    gCallback = Napi::ThreadSafeFunction();
  }
}

// The HID system's own answer to "is the configured key held right now",
// independent of event delivery. This is the reconciliation source of truth:
// a tap can be disabled for slowness and another app's active tap can swallow
// an edge, but CGEventSource state is maintained by the window server itself.
Napi::Value HotkeyPhysicallyDown(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const CGEventSourceStateID state = kCGEventSourceStateCombinedSessionState;
  switch (gConfig.kind) {
    case HotkeyKind::Fn: {
      const CGEventFlags flags = CGEventSourceFlagsState(state);
      return Napi::Boolean::New(env, (flags & kCGEventFlagMaskSecondaryFn) != 0);
    }
    case HotkeyKind::RightCmd:
      return Napi::Boolean::New(env, CGEventSourceKeyState(state, kVK_RightCommand));
    case HotkeyKind::RightOpt:
      return Napi::Boolean::New(env, CGEventSourceKeyState(state, kVK_RightOption));
    case HotkeyKind::Custom:
      if (gConfig.customKeyCode < 0) return Napi::Boolean::New(env, false);
      return Napi::Boolean::New(
          env, CGEventSourceKeyState(state, static_cast<CGKeyCode>(gConfig.customKeyCode)));
  }
  return Napi::Boolean::New(env, false);
}

// ---------------------------------------------------------------------------
// JS: hotkey listener
// ---------------------------------------------------------------------------

HotkeyKind ParseKind(const std::string& key) {
  if (key == "rightCmd") return HotkeyKind::RightCmd;
  if (key == "rightOpt") return HotkeyKind::RightOpt;
  if (key == "custom") return HotkeyKind::Custom;
  return HotkeyKind::Fn;
}

Napi::Value StartHotkeyListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startHotkeyListener(config, listener) expects (object, function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Restarting is the normal path (a rebind), so stop cleanly first.
  TearDownTap();
  ReleaseCallback();

  Napi::Object config = info[0].As<Napi::Object>();
  HotkeyConfig parsed;
  if (config.Has("key") && config.Get("key").IsString()) {
    parsed.kind = ParseKind(config.Get("key").As<Napi::String>().Utf8Value());
  }
  if (config.Has("customKeyCode") && config.Get("customKeyCode").IsNumber()) {
    parsed.customKeyCode = config.Get("customKeyCode").As<Napi::Number>().Int64Value();
  }
  if (config.Has("doubleTapHandsFree") && config.Get("doubleTapHandsFree").IsBoolean()) {
    parsed.doubleTapHandsFree = config.Get("doubleTapHandsFree").As<Napi::Boolean>().Value();
  }

  // A custom binding with no key code would match nothing; refuse rather than
  // install a tap that can never fire.
  if (parsed.kind == HotkeyKind::Custom && parsed.customKeyCode < 0) {
    // Fail soft: never throw into Electron bootstrap.
    return Napi::Boolean::New(env, false);
  }
  gConfig = parsed;

  const CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) |
                           CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp);

  // kCGEventTapOptionDefault is required wherever the tap must suppress: the
  // Custom case (holding the key must not type a character) and the fn case
  // (a bare fn press must not also fire macOS's globe-key actions — Apple
  // Dictation's trigger is the same double-press as our hands-free latch).
  // The right-hand modifiers stay listen-only, the stronger privacy guarantee.
  const CGEventTapOptions option =
      (gConfig.kind == HotkeyKind::Custom || gConfig.kind == HotkeyKind::Fn)
          ? kCGEventTapOptionDefault
          : kCGEventTapOptionListenOnly;

  gEventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, option, mask, TapCallback,
                               nullptr);
  if (gEventTap == nullptr && gConfig.kind == HotkeyKind::Fn) {
    // A suppressing tap needs more trust than a listener (Accessibility on
    // top of Input Monitoring). If macOS refuses it, degrade to the old
    // listen-only tap — a live hotkey that merely cannot silence the
    // globe-key actions — rather than a dead key. Custom stays fail-hard:
    // without suppression, holding it would type characters.
    gEventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                                 kCGEventTapOptionListenOnly, mask, TapCallback, nullptr);
    // (Returning nullptr from a listen-only tap's callback is defined to
    // leave the event stream untouched, so TapCallback needs no change.)
  }
  if (gEventTap == nullptr) {
    // Almost always missing Input Monitoring. Report it as a return value so
    // the app can point the user at the permission pane.
    return Napi::Boolean::New(env, false);
  }

  gRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gEventTap, 0);
  if (gRunLoopSource == nullptr) {
    TearDownTap();
    return Napi::Boolean::New(env, false);
  }

  // The TSFN must exist before the thread starts: the tap can fire the moment
  // its loop runs.
  gCallback = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "murmurHotkey",
                                            /* maxQueueSize */ 64, /* initialThreadCount */ 1);

  gTapThreadReady.store(false);
  gTapThread = std::thread([] {
    // Retained: a secondary thread's CFRunLoop is deallocated during thread
    // exit, and teardown needs a pointer that outlives the thread to stop the
    // loop safely. Released in TearDownTap after the join.
    gRunLoop = (CFRunLoopRef)CFRetain(CFRunLoopGetCurrent());
    CFRunLoopAddSource(gRunLoop, gRunLoopSource, kCFRunLoopCommonModes);
    CGEventTapEnable(gEventTap, true);
    // Watchdog: the disabled-by-timeout/user-input callbacks re-enable the tap
    // when the OS *says* it disabled it, but a tap can also go quiet without a
    // word (a wake from sleep, a TCC hiccup). A dictation key must never be
    // silently dead, so check every few seconds and re-arm. The timer lives on
    // this thread's loop and dies with it in teardown.
    CFRunLoopTimerRef watchdog = CFRunLoopTimerCreateWithHandler(
        kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 5.0, /* interval */ 5.0, 0, 0,
        ^(CFRunLoopTimerRef) {
          if (gEventTap != nullptr && gListening.load() && !CGEventTapIsEnabled(gEventTap)) {
            CGEventTapEnable(gEventTap, true);
          }
        });
    CFRunLoopAddTimer(gRunLoop, watchdog, kCFRunLoopCommonModes);
    CFRelease(watchdog);
    // Readiness is signalled from *inside* the running loop. A flag set here,
    // before CFRunLoopRun, would let a fast teardown issue CFRunLoopStop
    // against a loop that has not started — a stop that lands on nothing and
    // a join() that never returns.
    CFRunLoopObserverRef entry = CFRunLoopObserverCreateWithHandler(
        kCFAllocatorDefault, kCFRunLoopEntry, /* repeats */ false, 0,
        ^(CFRunLoopObserverRef, CFRunLoopActivity) { gTapThreadReady.store(true); });
    CFRunLoopAddObserver(gRunLoop, entry, kCFRunLoopCommonModes);
    CFRelease(entry);
    CFRunLoopRun();
  });
  // Bounded wait for the loop to be live, so a stop immediately after start
  // cannot race the source insertion.
  for (int i = 0; i < 1000 && !gTapThreadReady.load(); i += 1) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  gListening.store(true);
  return Napi::Boolean::New(env, true);
}

Napi::Value StopHotkeyListener(const Napi::CallbackInfo& info) {
  TearDownTap();
  ReleaseCallback();
  return info.Env().Undefined();
}

// ---------------------------------------------------------------------------
// JS: text insertion
// ---------------------------------------------------------------------------

Napi::Object MakeResult(Napi::Env env, bool ok, const char* error) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok && error != nullptr) result.Set("error", Napi::String::New(env, error));
  return result;
}

// Synthesize ⌘V into whatever owns input. The clipboard is the main process's
// job (it already has Electron's pasteboard handling for every flavour).
Napi::Value SendPasteShortcut(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (IsSecureEventInputEnabled()) {
    return MakeResult(env, false, "secure input is active");
  }
  if (!AXIsProcessTrusted()) {
    return MakeResult(env, false, "Accessibility permission is not granted");
  }

  // **Combined session state, not private.** A private source has its own
  // modifier state that the window server does not merge into the system's,
  // so an app that asks "is Command down right now?" — rather than reading the
  // flags on the event it was handed — sees no modifier and treats ⌘V as a
  // bare `v`. That is the "it typed the letter v into my document" bug: the
  // keystroke arrived, the modifier did not. Our own tap is kept out by the
  // marker below instead, which is what the private source was really for.
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
  if (source == nullptr) return MakeResult(env, false, "could not create an event source");

  // **The modifier is pressed, not merely asserted.** Setting the Command flag
  // on the `v` alone races: an app can process the key before the window
  // server's modifier state reflects it. Posting Command as its own event
  // first establishes the state every app agrees on, which is what a real
  // keyboard does.
  CGEventRef commandDown =
      CGEventCreateKeyboardEvent(source, static_cast<CGKeyCode>(kVK_Command), true);
  CGEventRef keyDown = CGEventCreateKeyboardEvent(source, static_cast<CGKeyCode>(kVK_ANSI_V), true);
  CGEventRef keyUp = CGEventCreateKeyboardEvent(source, static_cast<CGKeyCode>(kVK_ANSI_V), false);
  CGEventRef commandUp =
      CGEventCreateKeyboardEvent(source, static_cast<CGKeyCode>(kVK_Command), false);
  if (commandDown == nullptr || keyDown == nullptr || keyUp == nullptr || commandUp == nullptr) {
    for (CGEventRef event : {commandDown, keyDown, keyUp, commandUp}) {
      if (event != nullptr) CFRelease(event);
    }
    CFRelease(source);
    return MakeResult(env, false, "could not create the keyboard events");
  }

  CGEventSetFlags(commandDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);
  // The release carries no Command: it *is* the modifier going up, and leaving
  // the flag set here is how a stuck ⌘ ends up wedged in the target app.
  CGEventSetFlags(commandUp, static_cast<CGEventFlags>(0));

  // kCGHIDEventTap so the event enters at the lowest level and every app sees
  // it, including ones that install their own session taps.
  for (CGEventRef event : {commandDown, keyDown, keyUp, commandUp}) {
    MarkSynthetic(event);
    CGEventPost(kCGHIDEventTap, event);
  }

  for (CGEventRef event : {commandDown, keyDown, keyUp, commandUp}) CFRelease(event);
  CFRelease(source);

  return MakeResult(env, true, nullptr);
}

// AX fallback: write straight into the focused element. Used when the paste
// above reports failure, or for apps that drop synthetic keystrokes.
Napi::Value InsertTextViaAccessibility(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "insertTextViaAccessibility(text) expects a string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!AXIsProcessTrusted()) {
    return MakeResult(env, false, "Accessibility permission is not granted");
  }

  const std::string text = info[0].As<Napi::String>().Utf8Value();

  @autoreleasepool {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    if (system == nullptr) return MakeResult(env, false, "no system-wide accessibility element");

    CFTypeRef focusedApp = nullptr;
    AXError error =
        AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &focusedApp);
    if (error != kAXErrorSuccess || focusedApp == nullptr) {
      CFRelease(system);
      return MakeResult(env, false, "could not find the focused application");
    }

    CFTypeRef focusedElement = nullptr;
    error = AXUIElementCopyAttributeValue(static_cast<AXUIElementRef>(focusedApp),
                                          kAXFocusedUIElementAttribute, &focusedElement);
    CFRelease(focusedApp);
    CFRelease(system);

    if (error != kAXErrorSuccess || focusedElement == nullptr) {
      return MakeResult(env, false, "no focused text field");
    }

    AXUIElementRef element = static_cast<AXUIElementRef>(focusedElement);
    NSString* value = [NSString stringWithUTF8String:text.c_str()];
    if (value == nil) {
      CFRelease(element);
      return MakeResult(env, false, "text was not valid UTF-8");
    }

    // Replace the selection rather than the value: this inserts at the caret and
    // leaves the rest of the field alone. Setting kAXValue would wipe it.
    error = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute,
                                         (__bridge CFTypeRef)value);
    CFRelease(element);

    if (error != kAXErrorSuccess) {
      return MakeResult(env, false, "the focused element refused accessibility insertion");
    }
  }

  return MakeResult(env, true, nullptr);
}

// Command mode reads the current selection (PLAN §18.1) with the same element
// lookup as the insertion fallback, read-only. "No selection" is a normal
// answer — { ok: true, text: "" } — not an error; errors are reserved for a
// missing permission or an app that refuses accessibility entirely.
Napi::Value GetSelectedText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  if (!AXIsProcessTrusted()) {
    out.Set("ok", Napi::Boolean::New(env, false));
    out.Set("error", Napi::String::New(env, "Accessibility permission is not granted"));
    return out;
  }

  @autoreleasepool {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    if (system == nullptr) {
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "no system-wide accessibility element"));
      return out;
    }
    // This runs synchronously at hotkey-down on the JS thread. An unresponsive
    // target app must cost ~100 ms of latency, not the several seconds of the
    // default AX messaging timeout.
    AXUIElementSetMessagingTimeout(system, 0.1f);

    CFTypeRef focusedApp = nullptr;
    AXError error =
        AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &focusedApp);
    if (error != kAXErrorSuccess || focusedApp == nullptr) {
      CFRelease(system);
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "could not find the focused application"));
      return out;
    }

    CFTypeRef focusedElement = nullptr;
    error = AXUIElementCopyAttributeValue(static_cast<AXUIElementRef>(focusedApp),
                                          kAXFocusedUIElementAttribute, &focusedElement);
    CFRelease(focusedApp);
    CFRelease(system);

    if (error != kAXErrorSuccess || focusedElement == nullptr) {
      out.Set("ok", Napi::Boolean::New(env, true));
      out.Set("text", Napi::String::New(env, ""));
      return out;
    }

    CFTypeRef selected = nullptr;
    error = AXUIElementCopyAttributeValue(static_cast<AXUIElementRef>(focusedElement),
                                          kAXSelectedTextAttribute, &selected);
    CFRelease(focusedElement);

    if (error != kAXErrorSuccess || selected == nullptr ||
        CFGetTypeID(selected) != CFStringGetTypeID()) {
      if (selected != nullptr) CFRelease(selected);
      out.Set("ok", Napi::Boolean::New(env, true));
      out.Set("text", Napi::String::New(env, ""));
      return out;
    }

    NSString* text = (__bridge NSString*)selected;
    const char* utf8 = text.UTF8String;
    out.Set("ok", Napi::Boolean::New(env, true));
    out.Set("text", Napi::String::New(env, utf8 != nullptr ? utf8 : ""));
    CFRelease(selected);
  }

  return out;
}

/**
 * The few characters immediately before the insertion point (PLAN §18.1).
 *
 * Exists so dictation can match the capitalisation of what it is landing in:
 * text typed into the middle of an existing sentence should not arrive with a
 * capital. `sentence-case.ts` makes that decision; this only supplies the
 * evidence.
 *
 * A *parameterized* attribute for a short range rather than reading
 * kAXValueAttribute and slicing it. The focused element may hold an entire
 * document — a whole file in an editor, a long email — and copying megabytes
 * across the accessibility bridge at hotkey-down, on the JS thread, to look at
 * three characters would be a latency bug of our own making.
 *
 * Privacy: the range is bounded to `maxChars` (the caller asks for a handful),
 * it is never logged, and it goes nowhere except the pure function that
 * decides one boolean. That is a deliberately smaller read than
 * getSelectedText, which the user has explicitly selected.
 */
Napi::Value GetTextBeforeCursor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  int maxChars = 8;
  if (info.Length() > 0 && info[0].IsNumber()) {
    maxChars = info[0].As<Napi::Number>().Int32Value();
  }
  if (maxChars <= 0 || maxChars > 256) maxChars = 8;

  if (!AXIsProcessTrusted()) {
    out.Set("ok", Napi::Boolean::New(env, false));
    out.Set("error", Napi::String::New(env, "Accessibility permission is not granted"));
    return out;
  }

  @autoreleasepool {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    if (system == nullptr) {
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "no system-wide accessibility element"));
      return out;
    }
    // Same 100 ms budget as GetSelectedText: this runs at hotkey-down on the
    // JS thread, and an unresponsive target app must not stall the dictation.
    AXUIElementSetMessagingTimeout(system, 0.1f);

    CFTypeRef focusedApp = nullptr;
    AXError error =
        AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &focusedApp);
    if (error != kAXErrorSuccess || focusedApp == nullptr) {
      CFRelease(system);
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "could not find the focused application"));
      return out;
    }

    CFTypeRef focusedElement = nullptr;
    error = AXUIElementCopyAttributeValue(static_cast<AXUIElementRef>(focusedApp),
                                          kAXFocusedUIElementAttribute, &focusedElement);
    CFRelease(focusedApp);
    CFRelease(system);

    if (error != kAXErrorSuccess || focusedElement == nullptr) {
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "no focused element"));
      return out;
    }

    AXUIElementRef element = static_cast<AXUIElementRef>(focusedElement);

    CFTypeRef rangeValue = nullptr;
    error = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute, &rangeValue);
    if (error != kAXErrorSuccess || rangeValue == nullptr) {
      CFRelease(element);
      // Not an error the user can act on: plenty of controls have no text at
      // all. The caller treats a failure as "unknown" and changes nothing.
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "focused element has no insertion point"));
      return out;
    }

    CFRange selection = CFRangeMake(0, 0);
    const bool gotRange = AXValueGetValue(static_cast<AXValueRef>(rangeValue),
                                          kAXValueTypeCFRange, &selection);
    CFRelease(rangeValue);

    if (!gotRange) {
      CFRelease(element);
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "could not read the insertion point"));
      return out;
    }

    // At offset 0 there is nothing before the cursor — an empty field, or the
    // very top of one. Reported as success with empty text, which is a real
    // answer ("start a sentence") rather than a failure ("do not touch").
    if (selection.location <= 0) {
      CFRelease(element);
      out.Set("ok", Napi::Boolean::New(env, true));
      out.Set("text", Napi::String::New(env, ""));
      return out;
    }

    const CFIndex wanted = selection.location < maxChars ? selection.location : maxChars;
    CFRange before = CFRangeMake(selection.location - wanted, wanted);

    AXValueRef beforeValue = AXValueCreate(kAXValueTypeCFRange, &before);
    CFTypeRef text = nullptr;
    error = AXUIElementCopyParameterizedAttributeValue(
        element, kAXStringForRangeParameterizedAttribute, beforeValue, &text);
    if (beforeValue != nullptr) CFRelease(beforeValue);
    CFRelease(element);

    if (error != kAXErrorSuccess || text == nullptr ||
        CFGetTypeID(text) != CFStringGetTypeID()) {
      if (text != nullptr) CFRelease(text);
      // Many elements expose a selected range but not the string-for-range
      // parameterized attribute. Unknown, so the caller leaves the text alone.
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "focused element cannot report text by range"));
      return out;
    }

    NSString* value = (__bridge NSString*)text;
    const char* utf8 = value.UTF8String;
    out.Set("ok", Napi::Boolean::New(env, true));
    out.Set("text", Napi::String::New(env, utf8 != nullptr ? utf8 : ""));
    CFRelease(text);
  }

  return out;
}

// ---------------------------------------------------------------------------
// JS: environment queries
// ---------------------------------------------------------------------------

// True when a password field (or a password manager) owns keyboard input.
Napi::Value IsSecureInputActive(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), IsSecureEventInputEnabled() ? true : false);
}

// Title of a specific process's frontmost window (PLAN §18.2).
//
// This is the one place Murmur reads a window title, and it exists because it
// is the *only* way to tell a Google Meet tab from any other browser tab: a
// bundle id says "Chrome" for both. It is also the only source of a real
// meeting name for browser-hosted calls.
//
// Deliberately narrow, and the Help copy for Accessibility describes exactly
// this: it is called only for a process already holding both microphone and
// speakers, only while meeting detection is enabled and a candidate is being
// watched, and the result is never logged. It is not a general screen read and
// must not become one — `GetFrontmostApp` above still learns nothing but a
// bundle id.
//
// Note this takes a *pid*, not "the frontmost app": the process holding a
// call's audio is usually a helper, and the window belongs to its parent.
Napi::Value GetWindowTitle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  if (info.Length() < 1 || !info[0].IsNumber()) {
    out.Set("ok", Napi::Boolean::New(env, false));
    out.Set("error", Napi::String::New(env, "a pid is required"));
    return out;
  }
  if (!AXIsProcessTrusted()) {
    out.Set("ok", Napi::Boolean::New(env, false));
    out.Set("error", Napi::String::New(env, "Accessibility permission is not granted"));
    return out;
  }

  pid_t pid = static_cast<pid_t>(info[0].As<Napi::Number>().Int32Value());

  @autoreleasepool {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (application == nullptr) {
      out.Set("ok", Napi::Boolean::New(env, false));
      out.Set("error", Napi::String::New(env, "no accessibility element for that process"));
      return out;
    }
    // Same guard as GetSelectedText: a hung target app must cost ~100 ms, not
    // the several seconds of the default AX messaging timeout. This one runs
    // on a poll timer, so a blocked call would stall detection indefinitely.
    AXUIElementSetMessagingTimeout(application, 0.1f);

    CFTypeRef window = nullptr;
    AXError error =
        AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window);
    if (error != kAXErrorSuccess || window == nullptr) {
      // Fall back to the main window: a background call still has one, but it
      // is not "focused" while the user works in another app.
      error = AXUIElementCopyAttributeValue(application, kAXMainWindowAttribute, &window);
    }
    CFRelease(application);

    if (error != kAXErrorSuccess || window == nullptr) {
      out.Set("ok", Napi::Boolean::New(env, true));
      out.Set("title", Napi::String::New(env, ""));
      return out;
    }

    CFTypeRef title = nullptr;
    error = AXUIElementCopyAttributeValue(static_cast<AXUIElementRef>(window),
                                          kAXTitleAttribute, &title);
    CFRelease(window);

    if (error != kAXErrorSuccess || title == nullptr ||
        CFGetTypeID(title) != CFStringGetTypeID()) {
      if (title != nullptr) CFRelease(title);
      out.Set("ok", Napi::Boolean::New(env, true));
      out.Set("title", Napi::String::New(env, ""));
      return out;
    }

    NSString* text = (__bridge NSString*)title;
    const char* utf8 = text.UTF8String;
    out.Set("ok", Napi::Boolean::New(env, true));
    out.Set("title", Napi::String::New(env, utf8 != nullptr ? utf8 : ""));
    CFRelease(title);
  }

  return out;
}

// Bundle id + name of the frontmost app. No window titles, no screen content
// (PLAN §4) — this is the whole of what Murmur learns about the target app.
Napi::Value GetFrontmostApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (app == nil) return env.Null();

    NSString* bundleId = [app bundleIdentifier];
    if (bundleId == nil) return env.Null();
    NSString* name = [app localizedName];

    Napi::Object result = Napi::Object::New(env);
    result.Set("bundleId", Napi::String::New(env, [bundleId UTF8String]));
    result.Set("name", Napi::String::New(env, name != nil ? [name UTF8String] : ""));
    return result;
  }
}

// ---------------------------------------------------------------------------
// JS: permissions
// ---------------------------------------------------------------------------

// The microphone's authoritative state is whatever `getUserMedia` says in the
// capture renderer, so this module reports "unknown" rather than linking
// AVFoundation for one enum and risking two sources of truth.
const char* kMicrophoneState = "unknown";

const char* AccessibilityState() { return AXIsProcessTrusted() ? "granted" : "denied"; }

const char* InputMonitoringState() {
  // CGPreflightListenEventAccess is 10.15+; the deployment target is 13.0.
  return CGPreflightListenEventAccess() ? "granted" : "denied";
}

Napi::Value PermissionsCheck(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object status = Napi::Object::New(env);
  status.Set("microphone", Napi::String::New(env, kMicrophoneState));
  status.Set("accessibility", Napi::String::New(env, AccessibilityState()));
  status.Set("inputMonitoring", Napi::String::New(env, InputMonitoringState()));
  return status;
}

// Trigger the OS prompt where one exists, then report the resulting state.
// Returns a resolved promise so the JS side is uniformly async.
Napi::Value PermissionsRequest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  if (info.Length() < 1 || !info[0].IsString()) {
    deferred.Resolve(Napi::String::New(env, "unknown"));
    return deferred.Promise();
  }

  const std::string kind = info[0].As<Napi::String>().Utf8Value();

  if (kind == "accessibility") {
    // The prompt option shows the "open System Settings" alert; the plain
    // AXIsProcessTrusted() used by check() deliberately does not.
    @autoreleasepool {
      NSDictionary* options = @{(__bridge id)kAXTrustedCheckOptionPrompt : @YES};
      const bool trusted =
          AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options) ? true : false;
      deferred.Resolve(Napi::String::New(env, trusted ? "granted" : "denied"));
    }
    return deferred.Promise();
  }

  if (kind == "inputMonitoring") {
    // Prompts once per app per OS install; afterwards it is a no-op and the
    // user has to go through the deep link below.
    const bool granted = CGRequestListenEventAccess() ? true : false;
    deferred.Resolve(Napi::String::New(env, granted ? "granted" : "denied"));
    return deferred.Promise();
  }

  // Microphone is requested by the capture renderer's getUserMedia call.
  deferred.Resolve(Napi::String::New(env, kMicrophoneState));
  return deferred.Promise();
}

// Deep links into the System Settings panes. `x-apple.systempreferences:` is the
// documented scheme; these anchors are stable across Ventura–Sequoia.
Napi::Value PermissionsOpenSettings(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) return env.Undefined();

  const std::string kind = info[0].As<Napi::String>().Utf8Value();
  const char* anchor = "Privacy_Accessibility";
  if (kind == "inputMonitoring") {
    anchor = "Privacy_ListenEvent";
  } else if (kind == "microphone") {
    anchor = "Privacy_Microphone";
  }

  @autoreleasepool {
    NSString* urlString = [NSString
        stringWithFormat:@"x-apple.systempreferences:com.apple.preference.security?%s", anchor];
    NSURL* url = [NSURL URLWithString:urlString];
    if (url != nil) [[NSWorkspace sharedWorkspace] openURL:url];
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// JS: module metadata
// ---------------------------------------------------------------------------

Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value PlatformInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    NSString* description = [NSString stringWithFormat:@"darwin %ld.%ld.%ld %s (napi %d)",
                                                       (long)version.majorVersion,
                                                       (long)version.minorVersion,
                                                       (long)version.patchVersion, kArch,
                                                       NAPI_VERSION];
    return Napi::String::New(env, [description UTF8String]);
  }
}

// Runs when the environment is torn down (app quit, or a reload in dev). The
// tap must not outlive the process that owns its callback.
void ModuleCleanup(void* /*arg*/) {
  TearDownTap();
  ReleaseCallback();
}

}  // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
  exports.Set("platformInfo", Napi::Function::New(env, PlatformInfo));

  exports.Set("startHotkeyListener", Napi::Function::New(env, StartHotkeyListener));
  exports.Set("stopHotkeyListener", Napi::Function::New(env, StopHotkeyListener));
  exports.Set("hotkeyPhysicallyDown", Napi::Function::New(env, HotkeyPhysicallyDown));

  exports.Set("sendPasteShortcut", Napi::Function::New(env, SendPasteShortcut));
  exports.Set("insertTextViaAccessibility", Napi::Function::New(env, InsertTextViaAccessibility));
  exports.Set("getSelectedText", Napi::Function::New(env, GetSelectedText));
  exports.Set("getTextBeforeCursor", Napi::Function::New(env, GetTextBeforeCursor));
  exports.Set("getWindowTitle", Napi::Function::New(env, GetWindowTitle));

  exports.Set("isSecureInputActive", Napi::Function::New(env, IsSecureInputActive));
  exports.Set("getFrontmostApp", Napi::Function::New(env, GetFrontmostApp));

  Napi::Object permissions = Napi::Object::New(env);
  permissions.Set("check", Napi::Function::New(env, PermissionsCheck));
  permissions.Set("request", Napi::Function::New(env, PermissionsRequest));
  permissions.Set("openSettings", Napi::Function::New(env, PermissionsOpenSettings));
  exports.Set("permissions", permissions);

  napi_add_env_cleanup_hook(env, ModuleCleanup, nullptr);
  return exports;
}

NODE_API_MODULE(murmur_native, Init)

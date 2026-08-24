// Murmur Linux native glue (PLAN §4.1 / M8).
//
// Same N-API surface as the macOS and Windows modules. This file is additive
// under src/linux/ so neither of the other builds compiles it.
//
// Implemented here:
//   - isAvailable / platformInfo
//   - sendPasteShortcut (Ctrl+V via XTEST)
//   - hotkey listener (XRecord, listen-only, on its own thread)
//   - hotkeyPhysicallyDown (XQueryKeymap — the HID truth the orchestrator needs)
//   - getSelectedText (X11 PRIMARY selection)
//   - getFrontmostApp (_NET_ACTIVE_WINDOW → WM_CLASS)
//   - permissions check (no TCC twins; report what X11 actually offers)
//
// ---------------------------------------------------------------------------
// X11 only, and that is a product decision, not an oversight (PLAN §4.1).
//
// Under Wayland none of this works: XRecord observes only X11 clients, so a
// hotkey pressed in a native Wayland app is never delivered, and XTEST input
// lands nowhere. The failure is *silent* — XOpenDisplay succeeds through
// XWayland, the context is created, and no key ever arrives. That is exactly
// the dead-key symptom the rest of this codebase refuses to ship, so a Wayland
// session is detected up front and reported as unavailable with a reason the
// Hub can show. Wayland support needs the xdg-desktop-portal GlobalShortcuts
// protocol plus a uinput injector; that is its own milestone.
//
// Privacy: identical contract to the other two backends. The record callback
// looks at one keycode and returns; non-hotkey keys are never buffered, never
// compared against anything, never logged. getFrontmostApp reads WM_CLASS and
// deliberately not the window title.
// ---------------------------------------------------------------------------

#include <napi.h>

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xproto.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/record.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

namespace {

#if defined(__x86_64__)
constexpr const char* kArch = "x64";
#elif defined(__aarch64__)
constexpr const char* kArch = "arm64";
#else
constexpr const char* kArch = "unknown";
#endif

Napi::Object MakeResult(Napi::Env env, bool ok, const char* error) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok && error != nullptr) result.Set("error", Napi::String::New(env, error));
  return result;
}

double NowSeconds() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------
// Session + display
// ---------------------------------------------------------------------------

bool EnvEquals(const char* name, const char* value) {
  const char* actual = std::getenv(name);
  return actual != nullptr && std::strcmp(actual, value) == 0;
}

bool EnvSet(const char* name) {
  const char* actual = std::getenv(name);
  return actual != nullptr && actual[0] != '\0';
}

/**
 * True when this is a Wayland session.
 *
 * Checked before anything else because XWayland makes the broken case look
 * healthy: DISPLAY is set, XOpenDisplay succeeds, XRecord creates a context,
 * and then no key is ever delivered from a native Wayland client. Reporting
 * unavailable here is what keeps `available: false` honest.
 */
bool IsWaylandSession() {
  if (EnvEquals("XDG_SESSION_TYPE", "wayland")) return true;
  // WAYLAND_DISPLAY without an explicit x11 session type: a compositor is in
  // charge even if XWayland has handed us a DISPLAY.
  if (EnvSet("WAYLAND_DISPLAY") && !EnvEquals("XDG_SESSION_TYPE", "x11")) return true;
  return false;
}

// The main-thread connection. Every call below except the record thread uses
// it; the record thread opens its own two (XRecord requires a separate data
// connection, and sharing one Display across threads is how Xlib corrupts).
Display* gDisplay = nullptr;
Window gHelperWindow = 0;
bool gHasXTest = false;
bool gHasXRecord = false;
std::string gUnavailableReason;
/**
 * Whether the probe below has run, and what it concluded.
 *
 * Tracked separately from `gDisplay` because the two disagree in the case that
 * matters: an X server that connects fine but is missing XTEST or RECORD
 * leaves a non-null Display *and* an unavailable verdict. Keying the early
 * return on `gDisplay != nullptr` made this function answer false the first
 * time and true every time after, so `isAvailable()` reported one thing at
 * load and the opposite in Help.
 */
enum class Probe { NotRun, Ready, Unavailable };
Probe gProbe = Probe::NotRun;

/** One-shot connect + extension probe. Returns false with gUnavailableReason set. */
bool EnsureDisplay() {
  if (gProbe != Probe::NotRun) return gProbe == Probe::Ready;
  // Every path below is terminal: one verdict, cached for the process.
  gProbe = Probe::Unavailable;

  if (IsWaylandSession()) {
    gUnavailableReason =
        "Wayland session — Murmur's hotkey and paste need X11. Log in to an "
        "\"X11\" or \"Xorg\" session to dictate.";
    return false;
  }
  if (!EnvSet("DISPLAY")) {
    gUnavailableReason = "no DISPLAY — no X server to connect to";
    return false;
  }

  // Called before any other Xlib entry point: the record thread runs its own
  // connections concurrently with this one, and Xlib only promises to tolerate
  // that once this has run.
  XInitThreads();

  gDisplay = XOpenDisplay(nullptr);
  if (gDisplay == nullptr) {
    gUnavailableReason = "XOpenDisplay failed — cannot reach the X server";
    return false;
  }

  int eventBase = 0, errorBase = 0, major = 0, minor = 0;
  gHasXTest = XTestQueryExtension(gDisplay, &eventBase, &errorBase, &major, &minor) == True;
  gHasXRecord = XRecordQueryVersion(gDisplay, &major, &minor) == True;

  if (!gHasXTest && !gHasXRecord) {
    gUnavailableReason = "X server has neither the XTEST nor the RECORD extension";
  } else if (!gHasXTest) {
    gUnavailableReason = "X server has no XTEST extension — cannot paste";
  } else if (!gHasXRecord) {
    gUnavailableReason = "X server has no RECORD extension — cannot watch the hotkey";
  }

  // Unmapped 1×1 window, used only as the requestor for selection transfers.
  // Created even on the unavailable paths: reading the PRIMARY selection needs
  // neither XTEST nor RECORD, so a server missing them can still answer
  // getSelectedText.
  gHelperWindow = XCreateSimpleWindow(gDisplay, DefaultRootWindow(gDisplay), -10, -10, 1, 1, 0, 0, 0);
  XFlush(gDisplay);

  if (gUnavailableReason.empty()) gProbe = Probe::Ready;
  return gProbe == Probe::Ready;
}

/**
 * Weaker than EnsureDisplay: is there a usable connection at all?
 *
 * The capabilities are not all-or-nothing. Reading the PRIMARY selection and
 * looking up the frontmost window need neither XTEST nor RECORD, so a server
 * missing one of those should still answer them rather than refusing
 * everything because the hotkey cannot be installed.
 */
bool HaveDisplay() {
  EnsureDisplay();
  return gDisplay != nullptr;
}

// ---------------------------------------------------------------------------
// Hotkey
//
// XRecord is listen-only: unlike the CGEventTap and WH_KEYBOARD_LL backends
// this one *cannot* swallow a key. That rules out every preset whose contract
// depends on suppression — Caps Lock (would toggle caps on every dictation)
// and the Space chords (would type a space). Those are reported Unsupported
// rather than installed half-working, the same way the Windows backend refuses
// the Mac-only presets. Right Ctrl, the default, is never suppressed on any
// platform, so it behaves identically here.
// ---------------------------------------------------------------------------

enum class HotkeyKind {
  RightCtrl,
  RightAlt,    // "rightOpt" — Alt_R
  RightSuper,  // "rightCmd" — Super_R
  Custom,
  Unsupported,
};

struct LinuxHotkeyConfig {
  HotkeyKind kind = HotkeyKind::RightCtrl;
  int customKeycode = -1;
  bool doubleTapHandsFree = true;
};

// Mirrors HOTKEY.doubleTapMs and the other two backends.
constexpr double kDoubleTapSeconds = 0.35;
constexpr double kTapMaxSeconds = 0.30;

struct HotkeyEventPayload {
  int type;  // 0 = down, 1 = up, 2 = doubleTap
  double timestamp;
};

std::atomic<bool> gListening{false};
std::atomic<bool> gHotkeyDown{false};
/**
 * Set around our own XTEST paste.
 *
 * The Windows backend tags injected keys with dwExtraInfo and filters on it;
 * XRecord carries no such field, so this flag is the equivalent. It matters
 * only for a Custom binding on Ctrl or V — every other preset cannot collide
 * with the keys sendPasteShortcut synthesizes. It is a window, not a tag: an
 * edge already queued in the record connection when the flag goes up is still
 * delivered. Accepted, because the alternative (matching on keycode) would
 * also drop the user's real keypress.
 */
std::atomic<bool> gInjecting{false};

LinuxHotkeyConfig gConfig{};
double gLastDownAt = 0.0;
double gDownAt = 0.0;
bool gLastPressWasTap = false;

// Record thread state.
std::thread gRecordThread;
Display* gRecordCtrlDisplay = nullptr;  // creates/disables the context (main thread touches this)
Display* gRecordDataDisplay = nullptr;  // blocks inside XRecordEnableContext (record thread only)
XRecordContext gRecordContext = 0;
std::atomic<bool> gRecordRunning{false};

// The keycode the active preset watches, resolved once at start.
std::atomic<int> gWatchedKeycode{0};

Napi::ThreadSafeFunction gCallback;

void EmitHotkeyEvent(int type, double timestamp) {
  if (!gListening.load()) return;
  if (!gCallback) return;

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

  // Queue full or TSFN closing: drop rather than block the record thread.
  if (status != napi_ok) delete payload;
}

void HandleEdge(bool down) {
  const double now = NowSeconds();

  if (down) {
    if (gHotkeyDown.exchange(true)) return;  // auto-repeat; already down

    // Tap-then-tap, not hold-then-tap: requiring the previous press to have
    // ended short is what stops a long dictation hold followed immediately by
    // a new press from latching hands-free (see the mac tap and Win hook).
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

void RecordCallback(XPointer /*closure*/, XRecordInterceptData* data) {
  if (data == nullptr) return;

  if (data->category == XRecordFromServer && data->data != nullptr &&
      data->data_len > 0 && gListening.load() && !gInjecting.load()) {
    const xEvent* event = reinterpret_cast<const xEvent*>(data->data);
    const int type = event->u.u.type;
    if (type == KeyPress || type == KeyRelease) {
      // The whole of what this callback learns about a keystroke: one keycode,
      // compared against one number. Nothing is retained.
      const int keycode = event->u.u.detail;
      if (keycode == gWatchedKeycode.load()) {
        HandleEdge(type == KeyPress);
      }
    }
  }

  XRecordFreeData(data);
}

void RecordThreadMain() {
  // Blocks here until XRecordDisableContext lands on the control connection.
  XRecordEnableContext(gRecordDataDisplay, gRecordContext, RecordCallback, nullptr);
  gRecordRunning.store(false);
}

/** Resolve the X11 keycode for the configured preset, or 0 if unbindable. */
int ResolveKeycode(const LinuxHotkeyConfig& config) {
  if (config.kind == HotkeyKind::Custom) {
    // On Linux customKeyCode is an X11 keycode (8–255), not a CGKeyCode or a
    // Win32 VK. The same number means a different key on each platform, which
    // is why settings.ts refuses to sync a custom binding across them.
    return (config.customKeycode >= 8 && config.customKeycode <= 255) ? config.customKeycode : 0;
  }

  KeySym sym = NoSymbol;
  switch (config.kind) {
    case HotkeyKind::RightCtrl:
      sym = XK_Control_R;
      break;
    case HotkeyKind::RightAlt:
      sym = XK_Alt_R;
      break;
    case HotkeyKind::RightSuper:
      sym = XK_Super_R;
      break;
    default:
      return 0;
  }

  const KeyCode keycode = XKeysymToKeycode(gDisplay, sym);
  // 0 is Xlib's "this layout has no such key" answer — a keyboard with no
  // right-hand Ctrl, or a remapped layout. Better to refuse than to bind 0 and
  // watch for a key that can never arrive.
  return keycode == 0 ? 0 : static_cast<int>(keycode);
}

void ReleaseCallback() {
  if (gCallback) {
    gCallback.Release();
    gCallback = Napi::ThreadSafeFunction();
  }
}

/**
 * Stop the record thread and drop its connections.
 *
 * @returns true when the thread is *known* to have exited, so the thread-safe
 *   function is unreferenced and safe to release. False means it may still be
 *   running and the caller must leak the callback rather than free something
 *   the record callback can still reach — the same discipline as the mac tap
 *   and the Windows hook teardown.
 */
bool TearDownRecord() {
  gListening.store(false);
  gHotkeyDown.store(false);
  gLastDownAt = 0.0;
  gDownAt = 0.0;
  gLastPressWasTap = false;
  gWatchedKeycode.store(0);

  bool joined = true;

  if (gRecordContext != 0 && gRecordCtrlDisplay != nullptr) {
    // Unblocks XRecordEnableContext on the data connection.
    XRecordDisableContext(gRecordCtrlDisplay, gRecordContext);
    XFlush(gRecordCtrlDisplay);
  }

  if (gRecordThread.joinable()) {
    // No timed join in std::thread. The disable above is the documented way
    // out of XRecordEnableContext and the callback does no blocking work, so
    // this returns promptly; if the server were wedged we would rather block
    // here than free the callback underneath a live thread.
    gRecordThread.join();
  } else {
    joined = !gRecordRunning.load();
  }

  if (gRecordContext != 0 && gRecordCtrlDisplay != nullptr) {
    XRecordFreeContext(gRecordCtrlDisplay, gRecordContext);
  }
  gRecordContext = 0;

  if (gRecordDataDisplay != nullptr) {
    XCloseDisplay(gRecordDataDisplay);
    gRecordDataDisplay = nullptr;
  }
  if (gRecordCtrlDisplay != nullptr) {
    XCloseDisplay(gRecordCtrlDisplay);
    gRecordCtrlDisplay = nullptr;
  }

  return joined;
}

Napi::Value StartHotkeyListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startHotkeyListener(config, listener) expects (object, function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Restart is normal (settings rebind).
  if (TearDownRecord()) ReleaseCallback();

  // HaveDisplay, not EnsureDisplay: a server with RECORD but no XTEST can
  // still watch the key. Paste will fail on its own terms with its own message.
  if (!HaveDisplay() || !gHasXRecord) return Napi::Boolean::New(env, false);

  Napi::Object config = info[0].As<Napi::Object>();
  LinuxHotkeyConfig parsed;
  if (config.Has("key") && config.Get("key").IsString()) {
    const std::string key = config.Get("key").As<Napi::String>().Utf8Value();
    if (key == "rightCtrl") {
      parsed.kind = HotkeyKind::RightCtrl;
    } else if (key == "rightOpt") {
      parsed.kind = HotkeyKind::RightAlt;
    } else if (key == "rightCmd") {
      parsed.kind = HotkeyKind::RightSuper;
    } else if (key == "custom") {
      parsed.kind = HotkeyKind::Custom;
    } else {
      // fn never reaches X (the firmware eats it); capsLock and the Space
      // chords need suppression XRecord cannot do.
      parsed.kind = HotkeyKind::Unsupported;
    }
  }
  if (config.Has("customKeyCode") && config.Get("customKeyCode").IsNumber()) {
    parsed.customKeycode = config.Get("customKeyCode").As<Napi::Number>().Int32Value();
  }
  if (config.Has("doubleTapHandsFree") && config.Get("doubleTapHandsFree").IsBoolean()) {
    parsed.doubleTapHandsFree = config.Get("doubleTapHandsFree").As<Napi::Boolean>().Value();
  }

  if (parsed.kind == HotkeyKind::Unsupported) return Napi::Boolean::New(env, false);

  const int keycode = ResolveKeycode(parsed);
  if (keycode == 0) return Napi::Boolean::New(env, false);

  gConfig = parsed;
  gWatchedKeycode.store(keycode);

  // XRecord needs two connections: the context is created and later disabled
  // on the control one, while the data one blocks inside XRecordEnableContext.
  // Using a single connection for both deadlocks — it is blocked reading when
  // the disable would have to be written.
  gRecordCtrlDisplay = XOpenDisplay(nullptr);
  gRecordDataDisplay = XOpenDisplay(nullptr);
  if (gRecordCtrlDisplay == nullptr || gRecordDataDisplay == nullptr) {
    TearDownRecord();
    return Napi::Boolean::New(env, false);
  }

  XRecordRange* range = XRecordAllocRange();
  if (range == nullptr) {
    TearDownRecord();
    return Napi::Boolean::New(env, false);
  }
  range->device_events.first = KeyPress;
  range->device_events.last = KeyRelease;

  XRecordClientSpec clients = XRecordAllClients;
  gRecordContext = XRecordCreateContext(gRecordCtrlDisplay, 0, &clients, 1, &range, 1);
  XFree(range);

  if (gRecordContext == 0) {
    TearDownRecord();
    return Napi::Boolean::New(env, false);
  }
  XSync(gRecordCtrlDisplay, False);

  gCallback = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "murmurHotkey",
                                            /* maxQueueSize */ 64, /* initialThreadCount */ 1);

  gListening.store(true);
  gRecordRunning.store(true);
  gRecordThread = std::thread(RecordThreadMain);

  return Napi::Boolean::New(env, true);
}

Napi::Value StopHotkeyListener(const Napi::CallbackInfo& info) {
  if (TearDownRecord()) ReleaseCallback();
  return info.Env().Undefined();
}

Napi::Value ReleaseHotkeyLatch(const Napi::CallbackInfo& info) {
  // Nothing to un-swallow: XRecord never suppressed a key, so unlike the
  // Windows Space chords there is no synthetic key-up owed to anyone. Clearing
  // the latch is the whole job. The contract's "no synthesized user keys" rule
  // is satisfied trivially here.
  gHotkeyDown.store(false);
  return info.Env().Undefined();
}

Napi::Value HotkeyPhysicallyDown(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const int keycode = gWatchedKeycode.load();
  if (keycode <= 0 || !HaveDisplay()) return Napi::Boolean::New(env, gHotkeyDown.load());

  // The Linux HID truth. XQueryKeymap reports the server's current physical
  // key state, which is what lets the orchestrator reconcile a lost release —
  // the same job GetAsyncKeyState does on Windows and the IOHID check does on
  // macOS.
  char keys[32] = {};
  XQueryKeymap(gDisplay, keys);
  const bool down = (keys[keycode >> 3] & (1 << (keycode & 7))) != 0;
  return Napi::Boolean::New(env, down);
}

// ---------------------------------------------------------------------------
// Paste — Ctrl+V via XTEST (the clipboard save/set/restore dance lives in main)
// ---------------------------------------------------------------------------

/**
 * The gap between one transition of a synthetic chord and the next.
 *
 * Queued together, the four events reach the server in one batch and are
 * processed back to back, so the whole Ctrl+V lasts less than a millisecond. A
 * client that decides whether Ctrl is down by asking the server *now* — rather
 * than reading the state on the event it was handed — asks when it dequeues the
 * `v`, and by then Ctrl has already gone back up: it types a bare `v` into the
 * document. Same failure, and same fix, as the macOS path.
 *
 * The flush is the load-bearing half. Sleeping without it just delays the
 * batch: the requests sit in the client-side queue and still arrive together.
 *
 * XTEST has its own `delay` argument, which looks like the obvious way to do
 * this and is not: the wait happens inside the X server, which stalls every
 * other client for the duration. Better to block only ourselves.
 */
void PaceKeystroke() {
  XFlush(gDisplay);
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
}

Napi::Value SendPasteShortcut(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!HaveDisplay()) return MakeResult(env, false, gUnavailableReason.c_str());
  if (!gHasXTest) return MakeResult(env, false, "X server has no XTEST extension");

  const KeyCode ctrl = XKeysymToKeycode(gDisplay, XK_Control_L);
  const KeyCode v = XKeysymToKeycode(gDisplay, XK_v);
  if (ctrl == 0 || v == 0) {
    // A layout with no Latin `v` (Cyrillic, Greek, some Dvorak variants) has
    // no keycode to synthesize. Reported rather than silently pressing the
    // wrong key — main falls back to its own insertion path.
    return MakeResult(env, false, "keyboard layout has no Ctrl+V to synthesize");
  }

  // The chord is paced rather than sent as one burst — see PaceKeystroke. The
  // cost is that gInjecting stays up for ~30 ms instead of almost no time,
  // which widens the window in which a *real* Ctrl or V press by a user who
  // bound one as their custom hotkey is ignored. Accepted for the same reason
  // the flag is a window and not a tag: the paste lands immediately after the
  // hotkey was released, so pressing it again inside 30 ms means starting a new
  // dictation in the same breath as the last one ended.
  gInjecting.store(true);
  XTestFakeKeyEvent(gDisplay, ctrl, True, 0);
  PaceKeystroke();
  XTestFakeKeyEvent(gDisplay, v, True, 0);
  PaceKeystroke();
  XTestFakeKeyEvent(gDisplay, v, False, 0);
  PaceKeystroke();
  XTestFakeKeyEvent(gDisplay, ctrl, False, 0);
  XSync(gDisplay, False);
  gInjecting.store(false);

  return MakeResult(env, true, nullptr);
}

Napi::Value InsertTextViaAccessibility(const Napi::CallbackInfo& info) {
  // The macOS AX fallback has no cheap Linux twin: the equivalent is AT-SPI2
  // over D-Bus, which means libatspi, a running at-spi-bus-launcher, and
  // toolkit accessibility enabled in the target app — a large dependency for a
  // path that only exists to rescue apps that drop synthetic keystrokes.
  // Reported honestly so main keeps its clipboard result instead of believing
  // a fallback succeeded.
  return MakeResult(info.Env(), false, "accessibility insertion is not implemented on Linux");
}

// ---------------------------------------------------------------------------
// Selection — X11 PRIMARY (command mode)
// ---------------------------------------------------------------------------

Napi::Value GetSelectedText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (!HaveDisplay()) {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, gUnavailableReason.c_str()));
    return result;
  }

  // PRIMARY, not CLIPBOARD: on X11 PRIMARY *is* the live selection, updated by
  // the owner as the user drags. CLIPBOARD only changes on an explicit copy,
  // so reading it would hand command mode whatever was copied an hour ago.
  const Atom primary = XA_PRIMARY;
  const Atom utf8 = XInternAtom(gDisplay, "UTF8_STRING", False);
  const Atom prop = XInternAtom(gDisplay, "MURMUR_SELECTION", False);

  if (XGetSelectionOwner(gDisplay, primary) == None) {
    // No owner means nothing is selected anywhere — ok with empty text, which
    // the interface defines as "no selection" (not an error).
    result.Set("ok", Napi::Boolean::New(env, true));
    result.Set("text", Napi::String::New(env, ""));
    return result;
  }

  XDeleteProperty(gDisplay, gHelperWindow, prop);
  XConvertSelection(gDisplay, primary, utf8, prop, gHelperWindow, CurrentTime);
  XFlush(gDisplay);

  // The owner is another process, so this is a round trip. Bounded rather than
  // blocking forever: a hung or slow owner must not stall the dictation loop.
  XEvent event;
  bool notified = false;
  const double deadline = NowSeconds() + 0.30;
  while (NowSeconds() < deadline) {
    if (XCheckTypedWindowEvent(gDisplay, gHelperWindow, SelectionNotify, &event) == True) {
      notified = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  if (!notified || event.xselection.property == None) {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(
                            env, notified ? "selection owner refused to convert to UTF-8"
                                          : "selection owner did not respond"));
    return result;
  }

  Atom actualType = None;
  int actualFormat = 0;
  unsigned long items = 0, bytesAfter = 0;
  unsigned char* data = nullptr;
  // 64 KiB of 32-bit words. Long enough for any plausible command-mode
  // selection; a longer one arrives as INCR, handled below.
  const long maxWords = 16384;

  if (XGetWindowProperty(gDisplay, gHelperWindow, prop, 0, maxWords, True, AnyPropertyType,
                         &actualType, &actualFormat, &items, &bytesAfter, &data) != Success) {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "could not read the selection property"));
    return result;
  }

  const Atom incr = XInternAtom(gDisplay, "INCR", False);
  if (actualType == incr) {
    // Incremental transfer: the property holds a size, not the text. Refused
    // rather than half-read — a selection this large is not a command-mode
    // target, and a partial rewrite would be worse than none.
    if (data != nullptr) XFree(data);
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "selection is too large to read"));
    return result;
  }

  std::string text;
  if (data != nullptr) {
    text.assign(reinterpret_cast<const char*>(data), items);
    XFree(data);
  }

  result.Set("ok", Napi::Boolean::New(env, true));
  result.Set("text", Napi::String::New(env, text));
  return result;
}

// ---------------------------------------------------------------------------
// Frontmost app — _NET_ACTIVE_WINDOW → WM_CLASS
// ---------------------------------------------------------------------------

Napi::Value GetFrontmostApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!HaveDisplay()) return env.Null();

  const Atom activeAtom = XInternAtom(gDisplay, "_NET_ACTIVE_WINDOW", True);
  if (activeAtom == None) return env.Null();  // window manager is not EWMH

  Atom actualType = None;
  int actualFormat = 0;
  unsigned long items = 0, bytesAfter = 0;
  unsigned char* data = nullptr;

  if (XGetWindowProperty(gDisplay, DefaultRootWindow(gDisplay), activeAtom, 0, 1, False,
                         XA_WINDOW, &actualType, &actualFormat, &items, &bytesAfter,
                         &data) != Success ||
      data == nullptr) {
    return env.Null();
  }

  Window active = items > 0 ? *reinterpret_cast<Window*>(data) : 0;
  XFree(data);
  if (active == 0) return env.Null();

  // WM_CLASS lives on the client window; if the WM reported a frame we walk up
  // to whichever ancestor carries the hint.
  XClassHint hint{};
  Status got = XGetClassHint(gDisplay, active, &hint);
  for (int depth = 0; got == 0 && depth < 4; ++depth) {
    Window root = 0, parent = 0, *children = nullptr;
    unsigned int count = 0;
    if (XQueryTree(gDisplay, active, &root, &parent, &children, &count) == 0) break;
    if (children != nullptr) XFree(children);
    if (parent == 0 || parent == root) break;
    active = parent;
    got = XGetClassHint(gDisplay, active, &hint);
  }
  if (got == 0) return env.Null();

  // Deliberately NOT the window title. Titles carry document names, URLs and
  // email subjects; macOS reports a bundle id and Windows a process image name
  // for exactly that reason, and onboarding promises the user no more than
  // this. WM_CLASS's class field is the Linux equivalent of a bundle id.
  const std::string klass = hint.res_class != nullptr ? hint.res_class : "";
  const std::string instance = hint.res_name != nullptr ? hint.res_name : "";
  if (hint.res_class != nullptr) XFree(hint.res_class);
  if (hint.res_name != nullptr) XFree(hint.res_name);

  const std::string id = !klass.empty() ? klass : instance;
  if (id.empty()) return env.Null();

  Napi::Object result = Napi::Object::New(env);
  result.Set("bundleId", Napi::String::New(env, id));
  result.Set("name", Napi::String::New(env, id));
  return result;
}

Napi::Value IsSecureInputActive(const Napi::CallbackInfo& info) {
  // X11 has no EnableSecureEventInput twin. The nearest signal — probing for
  // an exclusive keyboard grab — would mean calling XGrabKeyboard on every
  // check, and a grab taken at the wrong moment steals input from whatever
  // dialog is asking for a password. That is a worse outcome than the thing it
  // detects, so this reports false and the X11 support matrix says so plainly.
  return Napi::Boolean::New(info.Env(), false);
}

// ---------------------------------------------------------------------------
// Permissions — what X11 actually offers, not a fake TCC
// ---------------------------------------------------------------------------

Napi::Value PermissionsCheck(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // Each row reports its own extension, so `HaveDisplay` rather than
  // `EnsureDisplay`: a server with RECORD but no XTEST should show one granted
  // and one unavailable, not both unavailable because the pair is incomplete.
  const bool connected = HaveDisplay();

  Napi::Object status = Napi::Object::New(env);
  // Owned by getUserMedia in the capture renderer, same as the other two.
  status.Set("microphone", Napi::String::New(env, "unknown"));
  // Linux gates these on the X server's extensions, not on a per-app grant:
  // there is no dialog to show, so "granted" here means "the capability is
  // present" and "unavailable" means no amount of user consent would help.
  status.Set("accessibility",
             Napi::String::New(env, connected && gHasXTest ? "granted" : "unavailable"));
  status.Set("inputMonitoring",
             Napi::String::New(env, connected && gHasXRecord ? "granted" : "unavailable"));
  return status;
}

Napi::Value PermissionsRequest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  if (info.Length() < 1 || !info[0].IsString()) {
    deferred.Resolve(Napi::String::New(env, "unknown"));
    return deferred.Promise();
  }
  const std::string kind = info[0].As<Napi::String>().Utf8Value();
  if (kind == "microphone") {
    deferred.Resolve(Napi::String::New(env, "unknown"));
    return deferred.Promise();
  }
  // Nothing to prompt for — report the current state rather than pretending a
  // request happened.
  const bool connected = HaveDisplay();
  const bool ok = kind == "accessibility" ? (connected && gHasXTest) : (connected && gHasXRecord);
  deferred.Resolve(Napi::String::New(env, ok ? "granted" : "unavailable"));
  return deferred.Promise();
}

Napi::Value PermissionsOpenSettings(const Napi::CallbackInfo& info) {
  // No per-app privacy pane to open on Linux; the Hub's Help text carries the
  // X11-vs-Wayland explanation instead.
  return info.Env().Undefined();
}

Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), EnsureDisplay());
}

Napi::Value PlatformInfo(const Napi::CallbackInfo& info) {
  const bool ready = EnsureDisplay();
  char buf[320];
  if (ready) {
    snprintf(buf, sizeof(buf), "linux %s X11 (XTEST %s, RECORD %s, napi %d)", kArch,
             gHasXTest ? "yes" : "no", gHasXRecord ? "yes" : "no", NAPI_VERSION);
  } else {
    snprintf(buf, sizeof(buf), "linux %s unavailable — %s", kArch, gUnavailableReason.c_str());
  }
  return Napi::String::New(info.Env(), buf);
}

// Runs when the environment is torn down (app quit, or a reload in dev). The
// record thread must not outlive the callback it posts into: without this, an
// exit path that skips stopHotkeyListener leaves the thread alive calling into
// a thread-safe function N-API is finalizing.
void ModuleCleanup(void* /*arg*/) {
  if (TearDownRecord()) ReleaseCallback();
  if (gDisplay != nullptr) {
    if (gHelperWindow != 0) XDestroyWindow(gDisplay, gHelperWindow);
    XCloseDisplay(gDisplay);
    gDisplay = nullptr;
    gHelperWindow = 0;
  }
}

}  // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
  exports.Set("platformInfo", Napi::Function::New(env, PlatformInfo));
  exports.Set("startHotkeyListener", Napi::Function::New(env, StartHotkeyListener));
  exports.Set("stopHotkeyListener", Napi::Function::New(env, StopHotkeyListener));
  exports.Set("releaseHotkeyLatch", Napi::Function::New(env, ReleaseHotkeyLatch));
  exports.Set("hotkeyPhysicallyDown", Napi::Function::New(env, HotkeyPhysicallyDown));
  exports.Set("sendPasteShortcut", Napi::Function::New(env, SendPasteShortcut));
  exports.Set("insertTextViaAccessibility", Napi::Function::New(env, InsertTextViaAccessibility));
  exports.Set("getSelectedText", Napi::Function::New(env, GetSelectedText));
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

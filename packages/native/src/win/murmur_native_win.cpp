// Murmur Windows native glue (PLAN §4.1 / WINDOWS-HANDOFF G4+).
//
// Same N-API surface as the macOS module. This file is additive under src/win/
// so Mac builds never compile it.
//
// Implemented now:
//   - isAvailable / platformInfo
//   - sendPasteShortcut (Ctrl+V via SendInput)
//   - getFrontmostApp (GetForegroundWindow → process image name)
//   - isSecureInputActive (best-effort: password edit styles)
//   - permissions check (Windows has no TCC twins; report honest defaults)
//   - WH_KEYBOARD_LL hotkey listener (Right Ctrl default + Windows chords)
//
// Privacy: never buffer or log non-hotkey content. The LL hook returns
// immediately for every key that is not the configured hotkey/chord.

#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>
#include <uiautomation.h>

#include <napi.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uuid.lib")

namespace {

#if defined(_M_X64) || defined(__x86_64__)
constexpr const char* kArch = "x64";
#elif defined(_M_ARM64) || defined(__aarch64__)
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

bool ProcessElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = sizeof(elevation);
  const BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
  CloseHandle(token);
  return ok && elevation.TokenIsElevated != 0;
}

bool ForegroundElevated() {
  HWND hwnd = GetForegroundWindow();
  if (hwnd == nullptr) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) return false;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return false;
  HANDLE token = nullptr;
  bool elevated = false;
  if (OpenProcessToken(process, TOKEN_QUERY, &token)) {
    TOKEN_ELEVATION elevation{};
    DWORD size = sizeof(elevation);
    if (GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size)) {
      elevated = elevation.TokenIsElevated != 0;
    }
    CloseHandle(token);
  }
  CloseHandle(process);
  return elevated;
}

// ---------------------------------------------------------------------------
// Paste: Ctrl+V via SendInput (clipboard choreography lives in main)
// ---------------------------------------------------------------------------

// Forward decls used by paste + secure-field checks (definitions below).
HWND ResolveFocusedHwnd();
bool IsPasswordClassHwnd(HWND hwnd);

/**
 * Stamped into `dwExtraInfo` on every key this addon synthesizes, so the hook
 * can tell our own input apart from the user's.
 *
 * Without it the paste is self-defeating: a Custom hotkey bound to `V` (or to
 * Ctrl) matches the very keystroke `sendPasteShortcut` injects, so the hook
 * swallows its own Ctrl+V — the text never lands — and the synthetic edge
 * starts a fresh dictation mid-insert. `LLKHF_INJECTED` alone is too broad: it
 * would also drop the agent's nut.js-driven keys, which the Windows gates use
 * to prove the hotkey path works.
 */
constexpr ULONG_PTR kMurmurInjectedTag = 0x4D524D52;  // 'MRMR'

bool IsOwnInjectedEvent(const KBDLLHOOKSTRUCT* kb) {
  return kb != nullptr && kb->dwExtraInfo == kMurmurInjectedTag;
}

Napi::Value SendPasteShortcut(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  HWND hwnd = GetForegroundWindow();
  if (hwnd == nullptr) {
    return MakeResult(env, false, "no focused window");
  }

  // Never paste into a password-class control (G8) — belt-and-braces with
  // TextInjector.precheck() which should refuse before STT starts.
  if (IsPasswordClassHwnd(ResolveFocusedHwnd())) {
    return MakeResult(env, false, "secure input is active");
  }

  // UIPI: a non-elevated process cannot synthesize input into an elevated one.
  if (!ProcessElevated() && ForegroundElevated()) {
    return MakeResult(
        env, false,
        "target app is elevated — run Murmur as admin or use a non-admin window");
  }

  // Attach to the foreground thread so SendInput is accepted (Windows focus rules).
  const DWORD fgThread = GetWindowThreadProcessId(hwnd, nullptr);
  const DWORD thisThread = GetCurrentThreadId();
  bool attached = false;
  if (fgThread != 0 && fgThread != thisThread) {
    attached = AttachThreadInput(thisThread, fgThread, TRUE) == TRUE;
  }
  SetForegroundWindow(hwnd);
  // Small settle so the target is ready to receive keystrokes.
  Sleep(30);

  // SendInput merges with real keyboard state, so a modifier the user happens
  // to be holding joins our chord: Ctrl+Alt+V opens Paste Special in Office and
  // Ctrl+Shift+V is paste-without-formatting elsewhere — neither inserts the
  // transcript. Insertion lands a second or two after release, with hands back
  // on the keyboard, so this is ordinary rather than exotic. macOS avoids it by
  // building the event on a private CGEventSource with flags set to exactly ⌘;
  // Windows has no such isolation, so lift the strays and put them back.
  const WORD kStrayModifiers[] = {VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN};
  WORD held[4] = {};
  int heldCount = 0;
  for (WORD vk : kStrayModifiers) {
    if ((GetAsyncKeyState(vk) & 0x8000) != 0) {
      INPUT up = {};
      up.type = INPUT_KEYBOARD;
      up.ki.wVk = vk;
      up.ki.dwFlags = KEYEVENTF_KEYUP;
      up.ki.dwExtraInfo = kMurmurInjectedTag;
      SendInput(1, &up, sizeof(INPUT));
      held[heldCount++] = vk;
    }
  }

  INPUT inputs[4] = {};
  // Ctrl down, V down, V up, Ctrl up — virtual-key form works across layouts.
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = VK_CONTROL;
  inputs[1].type = INPUT_KEYBOARD;
  inputs[1].ki.wVk = 'V';
  inputs[2].type = INPUT_KEYBOARD;
  inputs[2].ki.wVk = 'V';
  inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
  inputs[3].type = INPUT_KEYBOARD;
  inputs[3].ki.wVk = VK_CONTROL;
  inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
  for (INPUT& input : inputs) input.ki.dwExtraInfo = kMurmurInjectedTag;

  const UINT sent = SendInput(4, inputs, sizeof(INPUT));

  // Restore whatever we lifted, so a user still holding Shift keeps holding it.
  for (int i = 0; i < heldCount; i += 1) {
    INPUT down = {};
    down.type = INPUT_KEYBOARD;
    down.ki.wVk = held[i];
    down.ki.dwExtraInfo = kMurmurInjectedTag;
    SendInput(1, &down, sizeof(INPUT));
  }

  if (attached) AttachThreadInput(thisThread, fgThread, FALSE);

  if (sent != 4) {
    return MakeResult(env, false, "SendInput failed for Ctrl+V");
  }
  return MakeResult(env, true, nullptr);
}

// Best-effort: password edit boxes. Not as strong as macOS secure input.
Napi::Value InsertTextViaAccessibility(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "insertTextViaAccessibility(text) expects a string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Full UI Automation fallback lands with G5 polish; refuse clearly for now
  // so the injector falls through to a typed paste-failed rather than lying.
  return MakeResult(env, false, "UI Automation fallback not yet implemented on Windows");
}

// Resolve the HWND that currently owns keyboard focus (may be another process).
HWND ResolveFocusedHwnd() {
  // Preferred: GUITHREADINFO gives the focused control on the foreground thread
  // without AttachThreadInput races.
  HWND fg = GetForegroundWindow();
  if (fg != nullptr) {
    DWORD fgThread = GetWindowThreadProcessId(fg, nullptr);
    if (fgThread != 0) {
      GUITHREADINFO gti{};
      gti.cbSize = sizeof(gti);
      if (GetGUIThreadInfo(fgThread, &gti) && gti.hwndFocus != nullptr) {
        return gti.hwndFocus;
      }
    }
  }

  // Fallback: thread-local GetFocus, with attach for cross-process.
  HWND focus = GetFocus();
  if (focus != nullptr) return focus;
  if (fg == nullptr) return nullptr;
  DWORD fgThread = GetWindowThreadProcessId(fg, nullptr);
  DWORD thisThread = GetCurrentThreadId();
  if (fgThread != 0 && fgThread != thisThread) {
    if (AttachThreadInput(thisThread, fgThread, TRUE)) {
      focus = GetFocus();
      AttachThreadInput(thisThread, fgThread, FALSE);
    }
  }
  return focus;
}

// ---------------------------------------------------------------------------
// UI Automation: the only way to see a browser's password field
// ---------------------------------------------------------------------------
//
// macOS gets this for free — IsSecureEventInputEnabled() is a system-wide
// truth that covers every password field on the machine. Windows has no such
// call, and the classic checks below see nothing inside Chromium, Electron or
// UWP: a web password input lives in a render widget whose HWND has no
// ES_PASSWORD style and answers no EM_GETPASSWORDCHAR. Without UIA, "Murmur
// will not type here" would be a promise the Windows build cannot keep for the
// place users most need it — a browser login form.

IUIAutomation* gUia = nullptr;
bool gUiaTried = false;

IUIAutomation* GetUia() {
  if (gUia != nullptr) return gUia;
  if (gUiaTried) return nullptr;  // creation already failed once; do not retry
  gUiaTried = true;

  // Electron's main thread is already in an apartment; RPC_E_CHANGED_MODE just
  // means someone got there first, which is fine — we only need COM usable.
  const HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(init) && init != RPC_E_CHANGED_MODE) return nullptr;

  IUIAutomation* uia = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&uia))) ||
      uia == nullptr) {
    return nullptr;
  }

  // UIA calls cross into the target process. Bound them: this runs on the
  // Electron main thread at every dictation begin, and an unbounded wait on a
  // busy browser would stall the tray, the Bar and all IPC.
  IUIAutomation2* uia2 = nullptr;
  if (SUCCEEDED(uia->QueryInterface(IID_PPV_ARGS(&uia2))) && uia2 != nullptr) {
    uia2->put_ConnectionTimeout(200);
    uia2->put_TransactionTimeout(200);
    uia2->Release();
  }

  gUia = uia;
  return gUia;
}

void ReleaseUia() {
  if (gUia != nullptr) {
    gUia->Release();
    gUia = nullptr;
  }
}

bool IsPasswordViaUia(HWND hwnd) {
  IUIAutomation* uia = GetUia();
  if (uia == nullptr) return false;

  // The *focused element* is what will receive the paste. Going by HWND alone
  // would only ever reach the browser's outer render widget, which is never
  // itself the password field.
  IUIAutomationElement* element = nullptr;
  if (FAILED(uia->GetFocusedElement(&element)) || element == nullptr) {
    if (hwnd == nullptr) return false;
    if (FAILED(uia->ElementFromHandle(hwnd, &element)) || element == nullptr) return false;
  }

  VARIANT value;
  VariantInit(&value);
  bool isPassword = false;
  if (SUCCEEDED(element->GetCurrentPropertyValue(UIA_IsPasswordPropertyId, &value))) {
    if (value.vt == VT_BOOL) isPassword = value.boolVal == VARIANT_TRUE;
  }
  VariantClear(&value);
  element->Release();
  return isPassword;
}

// True when the focused control is a password-class edit (G8).
// Classic Win32 first because it is cheap and in-process; UIA covers the
// browser/UWP cases the classic checks structurally cannot see.
bool IsPasswordClassHwnd(HWND hwnd) {
  if (hwnd == nullptr || !IsWindow(hwnd)) return false;

  char className[128] = {};
  GetClassNameA(hwnd, className, static_cast<int>(sizeof(className)));

  // Some hosts use a dedicated class name without ES_PASSWORD on the outer HWND.
  if (strstr(className, "PasswordBox") != nullptr) return true;  // WPF

  // ES_PASSWORD (0x0020) is only meaningful for Edit controls — the low style
  // bits are class-specific, and 0x0020 collides with BS_LEFTTEXT,
  // LVS_SORTDESCENDING, CBS_OWNERDRAWVARIABLE and LBS_NOREDRAW. Testing it on
  // any focused window would refuse to type into ordinary checkboxes and lists.
  const bool isEditClass = _stricmp(className, "Edit") == 0 ||
                           _strnicmp(className, "RichEdit", 8) == 0 ||
                           _stricmp(className, "TEdit") == 0;
  if (!isEditClass) return false;

  const LONG_PTR style = GetWindowLongPtr(hwnd, GWL_STYLE);
  // Win32 / WinForms TextBox.UseSystemPasswordChar / many password dialogs.
  if ((style & ES_PASSWORD) != 0) return true;

  // EM_GETPASSWORDCHAR: non-zero means the edit is masking input. This crosses
  // a process boundary and runs on the Electron main thread at every dictation
  // begin, so it must time out: a plain SendMessageW to a hung foreground app
  // would freeze the tray, the Bar and all IPC for as long as that app is wedged.
  DWORD_PTR passwordChar = 0;
  if (SendMessageTimeoutW(hwnd, EM_GETPASSWORDCHAR, 0, 0,
                          SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &passwordChar) == 0) {
    return false;  // no answer in 50 ms — treat as "not proven secure"
  }
  return passwordChar != 0;
}

Napi::Value IsSecureInputActive(const Napi::CallbackInfo& info) {
  HWND focus = ResolveFocusedHwnd();
  // Either signal is enough to refuse. Refusing when the field is not secure
  // costs the user one dictation; typing into a password box that we failed to
  // recognise puts their password in the clipboard and on screen.
  if (IsPasswordClassHwnd(focus)) return Napi::Boolean::New(info.Env(), true);
  return Napi::Boolean::New(info.Env(), IsPasswordViaUia(focus));
}

// G9: true when UIPI would block paste into the frontmost window.
Napi::Value IsForegroundElevated(const Napi::CallbackInfo& info) {
  if (ProcessElevated()) {
    // We are elevated ourselves — UIPI does not block us.
    return Napi::Boolean::New(info.Env(), false);
  }
  return Napi::Boolean::New(info.Env(), ForegroundElevated());
}

Napi::Value GetFrontmostApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = GetForegroundWindow();
  if (hwnd == nullptr) return env.Null();

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) return env.Null();

  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return env.Null();

  wchar_t pathBuf[MAX_PATH] = {};
  DWORD size = MAX_PATH;
  std::string imageName;
  if (QueryFullProcessImageNameW(process, 0, pathBuf, &size)) {
    // basename of path
    const wchar_t* base = pathBuf;
    for (const wchar_t* p = pathBuf; *p; ++p) {
      if (*p == L'\\' || *p == L'/') base = p + 1;
    }
    // Size first, then convert. A fixed MAX_PATH byte buffer is not enough for
    // a non-ASCII executable name (UTF-8 needs up to 3 bytes per BMP char), and
    // on overflow WideCharToMultiByte writes nothing and returns 0 — which
    // would report "no frontmost app" for a perfectly ordinary window.
    const int needed = WideCharToMultiByte(CP_UTF8, 0, base, -1, nullptr, 0, nullptr, nullptr);
    if (needed > 0) {
      std::string narrow(static_cast<size_t>(needed), '\0');
      if (WideCharToMultiByte(CP_UTF8, 0, base, -1, narrow.data(), needed, nullptr, nullptr) > 0) {
        narrow.resize(static_cast<size_t>(needed) - 1);  // drop the NUL
        imageName = std::move(narrow);
      }
    }
  }
  CloseHandle(process);

  if (imageName.empty()) return env.Null();

  // Deliberately NOT the window title. Titles carry document names, URLs and
  // email subjects; the mac side says so in as many words ("No window titles,
  // no screen content — this is the whole of what Murmur learns about the
  // target app"), and onboarding promises users "the bundle id, nothing else".
  // The process image name is all the category map needs.
  Napi::Object result = Napi::Object::New(env);
  // Reuse bundleId field as process image name (orchestrator category map will
  // grow Windows process patterns separately).
  result.Set("bundleId", Napi::String::New(env, imageName));
  result.Set("name", Napi::String::New(env, imageName));
  return result;
}

// ---------------------------------------------------------------------------
// Hotkey: WH_KEYBOARD_LL (G6)
//
// Same privacy contract as macOS: listen only for the configured hotkey/chord;
// never buffer other key content. Suppression is targeted (Space in chords,
// Caps Lock, custom keys) — Right Ctrl is never swallowed system-wide so the
// rest of the keyboard keeps working.
// ---------------------------------------------------------------------------

enum class HotkeyKind {
  RightCtrl,
  CtrlSpace,
  AltSpace,
  CapsLock,
  Custom,
  Unsupported,  // Mac-only presets on a Windows build
};

struct WinHotkeyConfig {
  HotkeyKind kind = HotkeyKind::RightCtrl;
  int customVk = -1;
  bool doubleTapHandsFree = true;
};

// Two presses inside this window are a double-tap (mirrors HOTKEY.doubleTapMs).
constexpr double kDoubleTapSeconds = 0.35;

// A press this short is a tap; longer is a hold. Generous enough for a
// deliberate double-tap, short enough that no dictation hold qualifies.
constexpr double kTapMaxSeconds = 0.30;

struct HotkeyEventPayload {
  int type;  // 0 = down, 1 = up, 2 = doubleTap
  double timestamp;
};

std::atomic<bool> gListening{false};
std::atomic<bool> gHotkeyDown{false};
std::atomic<bool> gCtrlHeld{false};
std::atomic<bool> gAltHeld{false};

WinHotkeyConfig gConfig{};
double gLastDownAt = 0.0;
// When the current press began, so the up edge can classify it as tap or hold.
double gDownAt = 0.0;
// True when the previous press was a quick tap (down→up under kTapMaxSeconds).
bool gLastPressWasTap = false;

HHOOK gHook = nullptr;
HANDLE gHookThread = nullptr;
DWORD gHookThreadId = 0;
HANDLE gHookReadyEvent = nullptr;
std::atomic<bool> gHookInstallOk{false};

Napi::ThreadSafeFunction gCallback;

double NowSeconds() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

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

  // Queue full or TSFN closing: drop rather than block the hook thread
  // (which would stall every keystroke on the system).
  if (status != napi_ok) delete payload;
}

void HandleEdge(bool down) {
  const double now = NowSeconds();

  if (down) {
    if (gHotkeyDown.exchange(true)) return;  // auto-repeat; already down

    // A double-tap is tap-then-tap. Requiring the *previous* press to have
    // ended as a quick tap is what stops a long dictation hold, released and
    // immediately followed by a new press, from latching hands-free — the
    // "dictation never stops" symptom (mirrors the mac tap).
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

bool IsKeyDownEvent(const KBDLLHOOKSTRUCT* kb) {
  return (kb->flags & LLKHF_UP) == 0;
}

bool IsRightControlKey(const KBDLLHOOKSTRUCT* kb) {
  if (kb->vkCode == VK_RCONTROL) return true;
  // Some stacks report right Ctrl as extended VK_CONTROL.
  if (kb->vkCode == VK_CONTROL && (kb->flags & LLKHF_EXTENDED) != 0) return true;
  return false;
}

bool IsLeftOrRightControl(DWORD vk) {
  return vk == VK_LCONTROL || vk == VK_RCONTROL || vk == VK_CONTROL;
}

bool IsLeftOrRightAlt(DWORD vk) {
  return vk == VK_LMENU || vk == VK_RMENU || vk == VK_MENU;
}

void UpdateModifierState(const KBDLLHOOKSTRUCT* kb) {
  const bool down = IsKeyDownEvent(kb);
  // Aggregate left/right for chord presets. On key-up, re-sample async state so
  // releasing one side while the other is still held stays correct.
  if (IsLeftOrRightControl(kb->vkCode)) {
    if (down) {
      gCtrlHeld.store(true);
    } else {
      const bool still = (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0 ||
                         (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
      gCtrlHeld.store(still);
    }
  }
  if (IsLeftOrRightAlt(kb->vkCode)) {
    if (down) {
      gAltHeld.store(true);
    } else {
      const bool still = (GetAsyncKeyState(VK_LMENU) & 0x8000) != 0 ||
                         (GetAsyncKeyState(VK_RMENU) & 0x8000) != 0;
      gAltHeld.store(still);
    }
  }
}

void InjectKeyUp(WORD vk) {
  INPUT input = {};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = vk;
  input.ki.dwFlags = KEYEVENTF_KEYUP;
  // Tagged so our own hook skips it — otherwise releasing a swallowed chord
  // key re-enters ProcessHotkeyEvent and can toggle the latch straight back.
  input.ki.dwExtraInfo = kMurmurInjectedTag;
  SendInput(1, &input, sizeof(INPUT));
}

// Returns true when the event should be swallowed (targeted suppression).
bool ProcessHotkeyEvent(const KBDLLHOOKSTRUCT* kb) {
  UpdateModifierState(kb);
  const bool down = IsKeyDownEvent(kb);

  switch (gConfig.kind) {
    case HotkeyKind::RightCtrl: {
      if (!IsRightControlKey(kb)) return false;
      HandleEdge(down);
      // Never suppress Right Ctrl system-wide (matches Mac modifier policy).
      return false;
    }

    case HotkeyKind::CtrlSpace: {
      // Chord = Ctrl held + Space edge. We swallow Space only while the chord is
      // active. On any end path we inject KEYUP(Space) so the key cannot stick.
      if (kb->vkCode == VK_SPACE) {
        const bool ctrlDown =
            gCtrlHeld.load() || (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        if (down) {
          if (!ctrlDown) {
            if (gHotkeyDown.exchange(false)) InjectKeyUp(VK_SPACE);
            return false;
          }
          HandleEdge(true);
          return true;  // swallow Space so the chord does not type a space
        }
        // Space up while latched: end hold and swallow (we ate the down).
        if (gHotkeyDown.exchange(false)) {
          EmitHotkeyEvent(1, NowSeconds());
          return true;
        }
        return false;
      }
      // Ctrl released while latched → end hold + force Space KEYUP.
      if (!down && IsLeftOrRightControl(kb->vkCode) && gHotkeyDown.load()) {
        if ((GetAsyncKeyState(VK_LCONTROL) & 0x8000) == 0 &&
            (GetAsyncKeyState(VK_RCONTROL) & 0x8000) == 0) {
          gHotkeyDown.store(false);
          EmitHotkeyEvent(1, NowSeconds());
          InjectKeyUp(VK_SPACE);
        }
      }
      return false;
    }

    case HotkeyKind::AltSpace: {
      if (kb->vkCode == VK_SPACE) {
        const bool altDown =
            gAltHeld.load() || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        if (down) {
          if (!altDown) {
            if (gHotkeyDown.exchange(false)) InjectKeyUp(VK_SPACE);
            return false;
          }
          HandleEdge(true);
          return true;
        }
        if (gHotkeyDown.exchange(false)) {
          EmitHotkeyEvent(1, NowSeconds());
          return true;
        }
        return false;
      }
      if (!down && IsLeftOrRightAlt(kb->vkCode) && gHotkeyDown.load()) {
        if ((GetAsyncKeyState(VK_LMENU) & 0x8000) == 0 &&
            (GetAsyncKeyState(VK_RMENU) & 0x8000) == 0) {
          gHotkeyDown.store(false);
          EmitHotkeyEvent(1, NowSeconds());
          InjectKeyUp(VK_SPACE);
        }
      }
      return false;
    }

    case HotkeyKind::CapsLock: {
      if (kb->vkCode != VK_CAPITAL) return false;
      HandleEdge(down);
      // Swallow so hold-to-talk does not toggle Caps Lock.
      return true;
    }

    case HotkeyKind::Custom: {
      if (gConfig.customVk < 0 || static_cast<int>(kb->vkCode) != gConfig.customVk) return false;
      HandleEdge(down);
      return true;  // suppress custom key so it does not type
    }

    case HotkeyKind::Unsupported:
    default:
      return false;
  }
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION && gListening.load() && lParam != 0) {
    const KBDLLHOOKSTRUCT* kb = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    // Our own synthetic keys must never be read as hotkey edges — see
    // kMurmurInjectedTag. Other injected input (the agent's nut.js keys) is
    // deliberately still processed, which is what the Windows hotkey gate proves.
    if (!IsOwnInjectedEvent(kb) && ProcessHotkeyEvent(kb)) {
      return 1;  // swallow this key only
    }
  }
  return CallNextHookEx(gHook, nCode, wParam, lParam);
}

DWORD WINAPI HookThreadMain(LPVOID) {
  // Ensure this thread has a message queue before installing the hook.
  MSG msg;
  PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  HMODULE mod = nullptr;
  GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(&LowLevelKeyboardProc), &mod);

  gHook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, mod, 0);
  gHookInstallOk.store(gHook != nullptr);

  if (gHookReadyEvent != nullptr) SetEvent(gHookReadyEvent);

  if (gHook == nullptr) return 1;

  // Low-level hooks are delivered via this thread's message loop.
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (gHook != nullptr) {
    UnhookWindowsHookEx(gHook);
    gHook = nullptr;
  }
  return 0;
}

void ReleaseCallback() {
  if (gCallback) {
    gCallback.Release();
    gCallback = Napi::ThreadSafeFunction();
  }
}

/**
 * Stop the hook thread.
 *
 * @returns true when the thread is *known* to have exited, meaning the
 *   thread-safe function is now unreferenced and safe to release. False means
 *   the thread may still be running: the caller must leak the callback rather
 *   than free something the hook proc can still reach.
 */
bool TearDownHook() {
  gListening.store(false);
  gHotkeyDown.store(false);
  gCtrlHeld.store(false);
  gAltHeld.store(false);
  gLastDownAt = 0.0;
  gDownAt = 0.0;
  gLastPressWasTap = false;

  bool joined = true;
  if (gHookThreadId != 0) {
    if (PostThreadMessageW(gHookThreadId, WM_QUIT, 0, 0) == 0) {
      // The thread never built its message queue, so WM_QUIT has nowhere to
      // land and GetMessage will never return. Nothing left but to stop
      // touching it — gListening is already false, so it emits nothing.
      joined = false;
    }
  }
  if (gHookThread != nullptr) {
    if (joined && WaitForSingleObject(gHookThread, 3000) != WAIT_OBJECT_0) {
      joined = false;
    }
    CloseHandle(gHookThread);
    gHookThread = nullptr;
  }
  gHookThreadId = 0;

  // Only safe to unhook and release the callback once the thread is *known*
  // stopped: doing it while the thread is still live races the hook proc on
  // gHook and gCallback, which is precisely the use-after-free shape the mac
  // tap teardown was fixed for. A leaked hook beats a crash.
  if (!joined) {
    gHookInstallOk.store(false);
    return false;
  }

  // If the thread never ran Unhook (crash path), try once more.
  if (gHook != nullptr) {
    UnhookWindowsHookEx(gHook);
    gHook = nullptr;
  }
  gHookInstallOk.store(false);

  if (gHookReadyEvent != nullptr) {
    CloseHandle(gHookReadyEvent);
    gHookReadyEvent = nullptr;
  }
}

// Runs when the environment is torn down (app quit, or a reload in dev). The
// hook thread must not outlive the callback it posts into: without this, an
// exit path that skips stopHotkeyListener leaves the thread alive calling into
// a thread-safe function N-API is finalizing — the same use-after-free the mac
// tap teardown was fixed for.
void ModuleCleanup(void* /*arg*/) {
  if (TearDownHook()) ReleaseCallback();
  ReleaseUia();
}

HotkeyKind ParseWinKind(const std::string& key) {
  if (key == "rightCtrl") return HotkeyKind::RightCtrl;
  if (key == "ctrlSpace") return HotkeyKind::CtrlSpace;
  if (key == "altSpace") return HotkeyKind::AltSpace;
  if (key == "capsLock") return HotkeyKind::CapsLock;
  if (key == "custom") return HotkeyKind::Custom;
  // fn / rightCmd / rightOpt are Mac-only — install nothing useful.
  return HotkeyKind::Unsupported;
}

Napi::Value StartHotkeyListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startHotkeyListener(config, listener) expects (object, function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Restart is normal (settings rebind).
  if (TearDownHook()) ReleaseCallback();

  Napi::Object config = info[0].As<Napi::Object>();
  WinHotkeyConfig parsed;
  if (config.Has("key") && config.Get("key").IsString()) {
    parsed.kind = ParseWinKind(config.Get("key").As<Napi::String>().Utf8Value());
  }
  if (config.Has("customKeyCode") && config.Get("customKeyCode").IsNumber()) {
    // On Windows customKeyCode is a Win32 virtual-key code (not a Mac keycode).
    parsed.customVk = config.Get("customKeyCode").As<Napi::Number>().Int32Value();
  }
  if (config.Has("doubleTapHandsFree") && config.Get("doubleTapHandsFree").IsBoolean()) {
    parsed.doubleTapHandsFree = config.Get("doubleTapHandsFree").As<Napi::Boolean>().Value();
  }

  if (parsed.kind == HotkeyKind::Custom && parsed.customVk < 0) {
    // Fail soft: never throw into Electron bootstrap (UnhandledPromiseRejection).
    return Napi::Boolean::New(env, false);
  }
  if (parsed.kind == HotkeyKind::Unsupported) {
    // Do not install a hook that can never fire.
    return Napi::Boolean::New(env, false);
  }

  gConfig = parsed;

  gCallback = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "murmurHotkey",
                                            /* maxQueueSize */ 64, /* initialThreadCount */ 1);

  gHookReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  gHookInstallOk.store(false);

  gHookThread = CreateThread(nullptr, 0, HookThreadMain, nullptr, 0, &gHookThreadId);
  if (gHookThread == nullptr) {
    ReleaseCallback();
    if (gHookReadyEvent) {
      CloseHandle(gHookReadyEvent);
      gHookReadyEvent = nullptr;
    }
    return Napi::Boolean::New(env, false);
  }

  // Wait for the hook thread to finish SetWindowsHookEx.
  if (gHookReadyEvent != nullptr) {
    WaitForSingleObject(gHookReadyEvent, 5000);
  }

  if (!gHookInstallOk.load()) {
    if (TearDownHook()) ReleaseCallback();
    return Napi::Boolean::New(env, false);
  }

  gListening.store(true);
  return Napi::Boolean::New(env, true);
}

Napi::Value ReleaseHotkeyLatch(const Napi::CallbackInfo& info) {
  const bool wasDown = gHotkeyDown.exchange(false);
  // Only a Space chord can leave a *swallowed* Space down in the input stream,
  // and only if we were actually latched. Injecting on the strength of
  // GetAsyncKeyState alone would synthesize a key the user is physically
  // holding — this is called on every cancel, every failure and at boot, so on
  // the Right Ctrl default it would cut short someone's real spacebar press.
  // The contract (native/interface.ts) is explicit: no synthesized user keys.
  const bool spaceChord =
      gConfig.kind == HotkeyKind::CtrlSpace || gConfig.kind == HotkeyKind::AltSpace;
  if (wasDown && spaceChord && (GetAsyncKeyState(VK_SPACE) & 0x8000) != 0) {
    InjectKeyUp(VK_SPACE);
  }
  return info.Env().Undefined();
}

Napi::Value HotkeyPhysicallyDown(const Napi::CallbackInfo& info) {
  // Windows reconciliation: prefer async HID state for the active preset.
  bool down = gHotkeyDown.load();
  switch (gConfig.kind) {
    case HotkeyKind::RightCtrl:
      down = (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0 ||
             ((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 &&
              (GetAsyncKeyState(VK_LCONTROL) & 0x8000) == 0);
      break;
    case HotkeyKind::CtrlSpace:
      down = gHotkeyDown.load() ||
             ((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 &&
              (GetAsyncKeyState(VK_SPACE) & 0x8000) != 0);
      break;
    case HotkeyKind::AltSpace:
      down = gHotkeyDown.load() ||
             ((GetAsyncKeyState(VK_MENU) & 0x8000) != 0 &&
              (GetAsyncKeyState(VK_SPACE) & 0x8000) != 0);
      break;
    case HotkeyKind::CapsLock:
      down = (GetAsyncKeyState(VK_CAPITAL) & 0x8000) != 0;
      break;
    case HotkeyKind::Custom:
      if (gConfig.customVk >= 0)
        down = (GetAsyncKeyState(static_cast<int>(gConfig.customVk)) & 0x8000) != 0;
      break;
    default:
      break;
  }
  return Napi::Boolean::New(info.Env(), down);
}

Napi::Value StopHotkeyListener(const Napi::CallbackInfo& info) {
  if (TearDownHook()) ReleaseCallback();
  return info.Env().Undefined();
}

// ---------------------------------------------------------------------------
// Permissions — honest Windows mapping (no fake macOS TCC)
// ---------------------------------------------------------------------------

Napi::Value PermissionsCheck(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object status = Napi::Object::New(env);
  // Microphone is owned by getUserMedia in the capture renderer.
  status.Set("microphone", Napi::String::New(env, "unknown"));
  // No separate Accessibility/Input Monitoring grants on Windows.
  status.Set("accessibility", Napi::String::New(env, "granted"));
  status.Set("inputMonitoring", Napi::String::New(env, "granted"));
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
  } else {
    deferred.Resolve(Napi::String::New(env, "granted"));
  }
  return deferred.Promise();
}

Napi::Value PermissionsOpenSettings(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // Mic privacy settings (ms-settings:privacy-microphone).
  ShellExecuteW(nullptr, L"open", L"ms-settings:privacy-microphone", nullptr, nullptr, SW_SHOWNORMAL);
  return env.Undefined();
}

Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value PlatformInfo(const Napi::CallbackInfo& info) {
  char buf[128];
  snprintf(buf, sizeof(buf), "win32 %s (napi %d)", kArch, NAPI_VERSION);
  return Napi::String::New(info.Env(), buf);
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
  exports.Set("isSecureInputActive", Napi::Function::New(env, IsSecureInputActive));
  exports.Set("isForegroundElevated", Napi::Function::New(env, IsForegroundElevated));
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

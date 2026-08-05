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

#include <napi.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <string>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")

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

  const UINT sent = SendInput(4, inputs, sizeof(INPUT));
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

// True when the focused control is a password-class edit (G8).
// Best-effort: classic Win32 ES_PASSWORD and common password class names.
// Modern Chromium/UWP password fields need UIA later; we still refuse when we
// can detect the classic case so we never paste into a known password box.
bool IsPasswordClassHwnd(HWND hwnd) {
  if (hwnd == nullptr || !IsWindow(hwnd)) return false;

  char className[128] = {};
  GetClassNameA(hwnd, className, static_cast<int>(sizeof(className)));

  const LONG_PTR style = GetWindowLongPtr(hwnd, GWL_STYLE);
  // Win32 / WinForms TextBox.UseSystemPasswordChar / many password dialogs.
  if ((style & ES_PASSWORD) != 0) return true;

  // Some hosts use a dedicated class name without ES_PASSWORD on the outer HWND.
  if (_stricmp(className, "PasswordBox") == 0) return true;          // WPF
  if (strstr(className, "PasswordBox") != nullptr) return true;

  // EM_GETPASSWORDCHAR: non-zero means the edit is masking input.
  // Works for Edit/RichEdit across processes when the message is allowed.
  const LRESULT passwordChar = SendMessageW(hwnd, EM_GETPASSWORDCHAR, 0, 0);
  if (passwordChar != 0) return true;

  return false;
}

Napi::Value IsSecureInputActive(const Napi::CallbackInfo& info) {
  HWND focus = ResolveFocusedHwnd();
  return Napi::Boolean::New(info.Env(), IsPasswordClassHwnd(focus));
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
    char narrow[MAX_PATH] = {};
    WideCharToMultiByte(CP_UTF8, 0, base, -1, narrow, MAX_PATH, nullptr, nullptr);
    imageName = narrow;
  }
  CloseHandle(process);

  if (imageName.empty()) return env.Null();

  // Window title as friendly name (best-effort).
  wchar_t titleW[512] = {};
  GetWindowTextW(hwnd, titleW, 512);
  char title[512] = {};
  WideCharToMultiByte(CP_UTF8, 0, titleW, -1, title, 512, nullptr, nullptr);

  Napi::Object result = Napi::Object::New(env);
  // Reuse bundleId field as process image name (orchestrator category map will
  // grow Windows process patterns separately).
  result.Set("bundleId", Napi::String::New(env, imageName));
  result.Set("name", Napi::String::New(env, title[0] ? title : imageName.c_str()));
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

    const bool isDoubleTap = gConfig.doubleTapHandsFree && gLastDownAt > 0.0 &&
                             (now - gLastDownAt) <= kDoubleTapSeconds;
    gLastDownAt = now;
    EmitHotkeyEvent(isDoubleTap ? 2 : 0, now);
    return;
  }

  if (!gHotkeyDown.exchange(false)) return;  // spurious up
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
      if (kb->vkCode == VK_SPACE) {
        if (down) {
          if (!gCtrlHeld.load() && (GetAsyncKeyState(VK_CONTROL) & 0x8000) == 0) return false;
          HandleEdge(true);
          return true;  // swallow Space so the chord does not type a space
        }
        if (gHotkeyDown.load()) {
          HandleEdge(false);
          return true;
        }
        return false;
      }
      // Ctrl released while chord latched → end hold.
      if (!down && IsLeftOrRightControl(kb->vkCode) && gHotkeyDown.load()) {
        if ((GetAsyncKeyState(VK_LCONTROL) & 0x8000) == 0 &&
            (GetAsyncKeyState(VK_RCONTROL) & 0x8000) == 0) {
          HandleEdge(false);
        }
      }
      return false;
    }

    case HotkeyKind::AltSpace: {
      if (kb->vkCode == VK_SPACE) {
        if (down) {
          if (!gAltHeld.load() && (GetAsyncKeyState(VK_MENU) & 0x8000) == 0) return false;
          HandleEdge(true);
          return true;
        }
        if (gHotkeyDown.load()) {
          HandleEdge(false);
          return true;
        }
        return false;
      }
      if (!down && IsLeftOrRightAlt(kb->vkCode) && gHotkeyDown.load()) {
        if ((GetAsyncKeyState(VK_LMENU) & 0x8000) == 0 &&
            (GetAsyncKeyState(VK_RMENU) & 0x8000) == 0) {
          HandleEdge(false);
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
    // Only key messages — ignore injected synthetic input from ourselves if flagged
    // (optional: still process injected so agent-driven keys work for G6 proof).
    if (ProcessHotkeyEvent(kb)) {
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

void TearDownHook() {
  gListening.store(false);
  gHotkeyDown.store(false);
  gCtrlHeld.store(false);
  gAltHeld.store(false);
  gLastDownAt = 0.0;

  if (gHookThreadId != 0) {
    PostThreadMessageW(gHookThreadId, WM_QUIT, 0, 0);
  }
  if (gHookThread != nullptr) {
    WaitForSingleObject(gHookThread, 3000);
    CloseHandle(gHookThread);
    gHookThread = nullptr;
  }
  gHookThreadId = 0;

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
  TearDownHook();
  ReleaseCallback();

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
    Napi::Error::New(env, "custom hotkey requires customKeyCode").ThrowAsJavaScriptException();
    return env.Undefined();
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
    TearDownHook();
    ReleaseCallback();
    return Napi::Boolean::New(env, false);
  }

  gListening.store(true);
  return Napi::Boolean::New(env, true);
}

Napi::Value StopHotkeyListener(const Napi::CallbackInfo& info) {
  TearDownHook();
  ReleaseCallback();
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
  exports.Set("sendPasteShortcut", Napi::Function::New(env, SendPasteShortcut));
  exports.Set("insertTextViaAccessibility", Napi::Function::New(env, InsertTextViaAccessibility));
  exports.Set("isSecureInputActive", Napi::Function::New(env, IsSecureInputActive));
  exports.Set("getFrontmostApp", Napi::Function::New(env, GetFrontmostApp));

  Napi::Object permissions = Napi::Object::New(env);
  permissions.Set("check", Napi::Function::New(env, PermissionsCheck));
  permissions.Set("request", Napi::Function::New(env, PermissionsRequest));
  permissions.Set("openSettings", Napi::Function::New(env, PermissionsOpenSettings));
  exports.Set("permissions", permissions);

  return exports;
}

NODE_API_MODULE(murmur_native, Init)

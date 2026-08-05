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
//   - hotkey listener scaffold (start/stop no-op until WH_KEYBOARD_LL lands)
//
// Privacy: never buffer or log non-hotkey content.

#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>

#include <napi.h>

#include <atomic>
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

Napi::Value SendPasteShortcut(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  HWND hwnd = GetForegroundWindow();
  if (hwnd == nullptr) {
    return MakeResult(env, false, "no focused window");
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

Napi::Value IsSecureInputActive(const Napi::CallbackInfo& info) {
  // Heuristic: focused control with ES_PASSWORD. Full UIA later.
  HWND focus = GetFocus();
  if (focus == nullptr) {
    // Cross-process focus: GetFocus is thread-local; try foreground attach.
    HWND fg = GetForegroundWindow();
    if (fg == nullptr) return Napi::Boolean::New(info.Env(), false);
    DWORD fgThread = GetWindowThreadProcessId(fg, nullptr);
    DWORD thisThread = GetCurrentThreadId();
    if (fgThread != 0 && fgThread != thisThread) {
      AttachThreadInput(thisThread, fgThread, TRUE);
      focus = GetFocus();
      AttachThreadInput(thisThread, fgThread, FALSE);
    }
  }
  if (focus == nullptr) return Napi::Boolean::New(info.Env(), false);

  char className[64] = {};
  GetClassNameA(focus, className, static_cast<int>(sizeof(className)));
  // Standard Edit and RichEdit password styles.
  const LONG_PTR style = GetWindowLongPtr(focus, GWL_STYLE);
  const bool passwordEdit =
      (style & ES_PASSWORD) != 0 &&
      (strstr(className, "Edit") != nullptr || strstr(className, "edit") != nullptr);
  return Napi::Boolean::New(info.Env(), passwordEdit);
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
// Hotkey: scaffold — WH_KEYBOARD_LL lands in G6
// ---------------------------------------------------------------------------

std::atomic<bool> gListening{false};

Napi::Value StartHotkeyListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startHotkeyListener(config, listener) expects (object, function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Return false so main knows the global hook is not active yet — UI can still
  // use debug.simulateHotkey. G6 installs WH_KEYBOARD_LL here.
  gListening.store(false);
  return Napi::Boolean::New(env, false);
}

Napi::Value StopHotkeyListener(const Napi::CallbackInfo& info) {
  gListening.store(false);
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

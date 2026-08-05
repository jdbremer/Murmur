// Murmur's macOS glue (PLAN §4).
//
// Stage 1 ships only the module's skeleton: enough to prove the toolchain,
// the Node-API surface and the JS fallback path all work. The real work —
// the listen-only CGEventTap behind the hotkey, clipboard-swap + synthetic ⌘V
// insertion, the AX fallback, frontmost-app lookup, secure-input detection and
// the permission check/request/deep-link helpers — lands in Stage 2.
//
// The frameworks those need are already linked by binding.gyp, so adding a
// function here is a matter of writing it and exporting it from Init(): the
// JS wrapper in index.js picks up any function the binding provides and falls
// back to a no-op for the ones it does not.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

#include <napi.h>

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

// True once the module is loaded at all. The wrapper still decides whether the
// individual capabilities are usable — a loaded binding without Accessibility
// permission can do less than this flag suggests.
Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

// Free-form description surfaced in the Help panel and in logs.
Napi::Value PlatformInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    NSString* description = [NSString stringWithFormat:@"darwin %ld.%ld.%ld %s (napi %d)",
                                                       (long)version.majorVersion,
                                                       (long)version.minorVersion,
                                                       (long)version.patchVersion,
                                                       kArch,
                                                       NAPI_VERSION];
    return Napi::String::New(env, [description UTF8String]);
  }
}

}  // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
  exports.Set("platformInfo", Napi::Function::New(env, PlatformInfo));
  return exports;
}

NODE_API_MODULE(murmur_native, Init)

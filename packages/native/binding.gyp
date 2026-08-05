{
  "targets": [
    {
      "target_name": "murmur_native",
      "sources": [],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=9"],
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "sources": ["src/murmur_native.mm"],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "13.0",
              "OTHER_CFLAGS": ["-Wall", "-Wextra"]
            },
            "link_settings": {
              "libraries": [
                "$(SDKROOT)/System/Library/Frameworks/AppKit.framework",
                "$(SDKROOT)/System/Library/Frameworks/ApplicationServices.framework",
                "$(SDKROOT)/System/Library/Frameworks/Carbon.framework",
                "$(SDKROOT)/System/Library/Frameworks/CoreGraphics.framework",
                "$(SDKROOT)/System/Library/Frameworks/Foundation.framework"
              ]
            }
          }
        ]
      ]
    }
  ]
}

// Captures system audio on macOS 14.2+ and writes it to stdout.
//
// Deliberately a standalone binary rather than part of `@murmur/native`.
// A CoreAudio IOProc runs on a realtime thread where allocating, taking a
// lock, or calling into a JavaScript runtime does not merely break our capture
// — it glitches the audio of the call the user is actually in. Keeping that
// constraint inside a separate process means it applies to this file and
// nothing else, a crash dies with the subprocess instead of taking Murmur
// down, and a leaked aggregate device is reaped by the OS rather than left
// behind in Audio MIDI Setup.
//
// Protocol:
//   stdout — raw little-endian Float32 PCM at the tap's native rate.
//   stderr — one JSON object per line: {"type":"format"|"start"|"error", ...}
//
// Usage: macos-audio-tap [--exclude-pid <pid>]
//
// Build: see scripts/build-audio-tap.sh

import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

// MARK: - Event reporting

/// Hand-rolled rather than JSONEncoder: this has to work from an error path
/// where allocating a whole encoder is the last thing we want to depend on.
func emit(_ fields: [String: Any]) {
    var parts: [String] = []
    for (key, value) in fields.sorted(by: { $0.key < $1.key }) {
        let rendered: String
        switch value {
        case let n as Int: rendered = String(n)
        case let d as Double: rendered = String(d)
        case let b as Bool: rendered = b ? "true" : "false"
        default:
            let escaped = String(describing: value)
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: " ")
            rendered = "\"\(escaped)\""
        }
        parts.append("\"\(key)\":\(rendered)")
    }
    FileHandle.standardError.write(Data(("{" + parts.joined(separator: ",") + "}\n").utf8))
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

/// A tap that macOS refuses to grant reports this, rather than failing to be
/// created. It is the only reliable signal that permission was declined —
/// note that a *silent* denial is also possible, which is why the TypeScript
/// side additionally checks whether any non-zero sample ever arrives.
func codeFor(_ status: OSStatus) -> String {
    status == kAudioHardwareIllegalOperationError ? "permission_denied" : "coreaudio_error"
}

// MARK: - Arguments

var excludePid: pid_t = 0
var listOnly = false
var args = Array(CommandLine.arguments.dropFirst())
while let flag = args.first {
    args.removeFirst()
    if flag == "--exclude-pid", let raw = args.first, let value = pid_t(raw) {
        excludePid = value
        args.removeFirst()
    } else if flag == "--list" {
        listOnly = true
    }
}

guard #available(macOS 14.2, *) else {
    fail("unsupported_os", "System audio capture needs macOS 14.2 or later.")
}

// MARK: - Process enumeration
//
// Which processes are playing and/or recording right now. This is how meetings
// are detected, and it is worth being explicit that it needs **no permission
// of any kind** — only capturing audio does. So it is safe to run on a timer
// for a user who has granted nothing.
//
// Note that the process holding a call's audio is a *helper*: Teams shows up
// as `com.microsoft.teams2.modulehost` and several `...helper` entries, never
// as `com.microsoft.teams`. Matching is done by prefix on the JS side.

/// Deliberately concrete rather than generic over `T`: a generic version reads
/// an arbitrary type through a raw pointer, which the compiler rightly warns
/// about because it would silently misbehave for anything holding an object
/// reference. Both properties we need are plain 32-bit integers.
func processUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32 {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    return status == noErr ? value : 0
}

func processPID(_ object: AudioObjectID) -> pid_t {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyPID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    return status == noErr ? value : 0
}

func processBundleID(_ object: AudioObjectID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    guard status == noErr, let unmanaged = value else { return nil }
    let string = unmanaged.takeRetainedValue() as String
    return string.isEmpty ? nil : string
}

func jsonString(_ value: String) -> String {
    "\"" + value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        + "\""
}

if listOnly {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let sizeStatus = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    )
    var entries: [String] = []
    if sizeStatus == noErr, size > 0 {
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &objects
        )
        if status == noErr {
            for object in objects {
                let pid = processPID(object)
                let input = processUInt32(object, kAudioProcessPropertyIsRunningInput)
                let output = processUInt32(object, kAudioProcessPropertyIsRunningOutput)
                let bundle = processBundleID(object)
                entries.append(
                    "{\"pid\":\(pid),"
                        + "\"bundleId\":\(bundle.map(jsonString) ?? "null"),"
                        + "\"runningInput\":\(input != 0),"
                        + "\"runningOutput\":\(output != 0)}"
                )
            }
        }
    }
    print("{\"processes\":[" + entries.joined(separator: ",") + "]}")
    exit(0)
}

// MARK: - Build the tap

/// Translate a unix pid into the audio object CoreAudio knows it by.
func audioObject(for pid: pid_t) -> AudioObjectID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var input = pid
    var out = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address,
        UInt32(MemoryLayout<pid_t>.size), &input, &size, &out
    )
    return status == noErr ? out : AudioObjectID(kAudioObjectUnknown)
}

let description = CATapDescription()
description.name = "Murmur meeting capture"
description.uuid = UUID()
description.isMono = true
description.isPrivate = true          // invisible to every other app
description.muteBehavior = .unmuted   // the user must still hear the meeting

// Tap the whole system rather than one app. Enumerating a specific app's audio
// processes is fragile in a way that fails silently: Teams alone runs five, a
// browser spawns new helpers mid-call, and missing one means capturing nothing
// while appearing to work. An exclusive tap with an empty (or self-only)
// exclusion list cannot miss. The cost is that background music lands in the
// transcript, which is a far better failure than an empty one.
description.isExclusive = true
description.isMixdown = true
if excludePid > 0 {
    let selfObject = audioObject(for: excludePid)
    description.processes = selfObject == AudioObjectID(kAudioObjectUnknown) ? [] : [selfObject]
} else {
    description.processes = []
}

var tapID = AudioObjectID(kAudioObjectUnknown)
let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
guard tapStatus == noErr, tapID != AudioObjectID(kAudioObjectUnknown) else {
    fail(codeFor(tapStatus), "Could not create the audio tap (OSStatus \(tapStatus)).")
}

/// A tap on its own delivers nothing — it has to be wrapped in an aggregate
/// device with an IOProc installed. Getting this wrong is not loud: an
/// aggregate missing its clock reference still runs and still calls back, and
/// simply hands over perfectly-timed silence, which looks exactly like a
/// permission denial.
func tapUID() -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    // Read it as an Unmanaged reference: CoreAudio hands back a +1-retained
    // CFString, and reading straight into a `CFString` variable lets ARC
    // release something it never retained.
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &value)
    guard status == noErr, let unmanaged = value else { return nil }
    return unmanaged.takeRetainedValue() as String
}

func tapFormat() -> AudioStreamBasicDescription? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
    return status == noErr ? asbd : nil
}

guard let uid = tapUID() else {
    AudioHardwareDestroyProcessTap(tapID)
    fail("tap_uid", "The tap did not report a UID.")
}
guard let format = tapFormat(), format.mSampleRate > 0 else {
    AudioHardwareDestroyProcessTap(tapID)
    fail("tap_format", "The tap did not report a usable format.")
}

let aggregateUID = "com.murmur.meeting-tap.\(UUID().uuidString)"
let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "Murmur meeting capture",
    kAudioAggregateDeviceUIDKey: aggregateUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [],
    kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapUIDKey: uid, kAudioSubTapDriftCompensationKey: true]
    ],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
let aggregateStatus = AudioHardwareCreateAggregateDevice(
    aggregateDescription as CFDictionary, &aggregateID
)
guard aggregateStatus == noErr, aggregateID != AudioObjectID(kAudioObjectUnknown) else {
    AudioHardwareDestroyProcessTap(tapID)
    fail(codeFor(aggregateStatus), "Could not create the aggregate device (OSStatus \(aggregateStatus)).")
}

emit([
    "type": "format",
    "sampleRate": Int(format.mSampleRate),
    "channels": Int(format.mChannelsPerFrame),
])

// MARK: - Teardown
//
// Reverse order, and it must run on every exit path. A leaked private
// aggregate device outlives the process and shows up in Audio MIDI Setup.

var ioProcID: AudioDeviceIOProcID?
var tornDown = false
let teardownLock = NSLock()

func teardown() {
    teardownLock.lock()
    defer { teardownLock.unlock() }
    guard !tornDown else { return }
    tornDown = true

    if let proc = ioProcID {
        AudioDeviceStop(aggregateID, proc)
        AudioDeviceDestroyIOProcID(aggregateID, proc)
    }
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
}

atexit { teardown() }

// Retained for the life of the process: a DispatchSource that deallocates is
// cancelled, and a cancelled SIGTERM handler means a leaked aggregate device.
var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { teardown(); exit(0) }
    source.resume()
    signalSources.append(source)
}

// MARK: - Capture

/// stdout is written from the IOProc's realtime thread, so it must never
/// allocate or block on a lock. `write(2)` on a pipe is the cheapest thing
/// available; a full pipe (a stalled reader) blocks briefly rather than
/// growing an unbounded queue, which is the trade we want — dropping recent
/// audio beats accumulating minutes of it in RAM.
let stdoutFD = FileHandle.standardOutput.fileDescriptor

let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
    _, inputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    for buffer in buffers {
        guard let data = buffer.mData, buffer.mDataByteSize > 0 else { continue }
        var offset = 0
        let total = Int(buffer.mDataByteSize)
        while offset < total {
            let written = write(stdoutFD, data.advanced(by: offset), total - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}

guard ioStatus == noErr, let proc = ioProcID else {
    teardown()
    fail(codeFor(ioStatus), "Could not install the IO proc (OSStatus \(ioStatus)).")
}

let startStatus = AudioDeviceStart(aggregateID, proc)
guard startStatus == noErr else {
    teardown()
    fail(codeFor(startStatus), "Could not start the aggregate device (OSStatus \(startStatus)).")
}

emit(["type": "start", "sampleRate": Int(format.mSampleRate)])

// Exit when the parent goes away: if Murmur crashes, this must not survive it
// still holding a tap on the user's audio.
let parentWatch = DispatchSource.makeTimerSource(queue: .main)
parentWatch.schedule(deadline: .now() + 1, repeating: 1)
parentWatch.setEventHandler {
    if getppid() == 1 { teardown(); exit(0) }
}
parentWatch.resume()

dispatchMain()

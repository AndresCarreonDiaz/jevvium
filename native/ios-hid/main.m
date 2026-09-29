// jevvium-hid: sends touches and key presses straight into a booted iOS Simulator.
//
// XCTest, which Appium drives, takes about 400 ms per tap on the simulator. This
// sends touch and key events through Apple's private SimulatorKit, CoreSimulator
// and libxpc interfaces instead, building touches with the same SimulatorKit
// function the Simulator app uses for a mouse click, and returns as soon as the
// simulator has accepted them.
//
// Touches go over SimulatorKit's HID port. Key presses go to the simulator's
// dtuhidd service over XPC. Simulators from Xcode 27 on ignore key presses on the
// HID port, so the port carries keys only on older ones.
//
// The simulator is told a hardware keyboard is connected, like the Simulator
// app's Connect Hardware Keyboard option, so typing never raises the on-screen
// keyboard. Otherwise it shows on some simulators and not others, depending on
// their history.
//
// This is an Objective-C port of the approach used by Meta's idb
// (https://github.com/facebook/idb): its single-finger Indigo touch message and its
// dtuhidd keyboard transport. Those portions are derived from idb, Copyright (c)
// Meta Platforms, Inc. and affiliates, under the MIT license in ./NOTICE.
//
// Usage: jevvium-hid <developer-dir> <udid>
//
// Prints "ready" once connected, then reads one command per line from stdin and
// answers each with "ok" or "error <reason>":
//   tap <x> <y> [holdMs]   x and y as fractions of the screen, from the top left
//   text <characters>      types printable ASCII on a hardware keyboard
//   key <usage> [shift]    presses one key by its USB HID usage code
//   clear                  selects everything in the focused field and deletes it
//
// The "ready" line names the keyboard path: dtuhidd-keyboard, legacy-keyboard, or
// no-keyboard (typing commands then answer with an error, and jevvium types through
// Appium instead).

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/runtime.h>
#import <stdio.h>
#import <unistd.h>
#import <xpc/xpc.h>

// The private classes are looked up at run time; these describe the few methods used.
@protocol JVServiceContext
+ (id)sharedServiceContextForDeveloperDir:(NSString *)developerDir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
@end

@protocol JVDeviceSet
- (NSArray *)devices;
@end

@protocol JVDevice
- (NSUUID *)UDID;
- (NSString *)stateString;
- (mach_port_t)lookup:(NSString *)serviceName error:(NSError **)error;
- (BOOL)setHardwareKeyboardEnabled:(BOOL)enabled keyboardType:(unsigned char)type error:(NSError **)error;
@end

@protocol JVHIDClient
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message
           freeWhenDone:(BOOL)freeWhenDone
        completionQueue:(dispatch_queue_t)queue
             completion:(void (^)(NSError *error))completion;
@end

// SimulatorKit's message builders.
typedef void *(*MouseEventBuilder)(CGPoint *point, CGPoint *secondPoint, uint32_t target, uint64_t eventType,
                                   CGSize size, uint32_t edge);
typedef void *(*KeyboardBuilder)(int32_t usage, int32_t direction);
// libxpc calls that connect the host to a service inside the simulator.
typedef xpc_object_t (*EndpointFromPort)(mach_port_t port, uint64_t unknown1, uint64_t unknown2)
    __attribute__((ns_returns_retained));
typedef void (*EnableSimToHost)(xpc_connection_t connection);

static MouseEventBuilder buildMouseEvent;
static KeyboardBuilder buildKeyboardEvent;
static id<JVHIDClient> client;
static dispatch_queue_t sendQueue;
static xpc_connection_t keyboardService;  // dtuhidd, when the simulator has it
static BOOL keyboardAvailable;
static const char *kKeyboardServiceName = "com.apple.coredevice.feature.remote.hid.digitizer";

// Layout of a single-finger touch message. Offsets are from the start of the message.
static const size_t kPayloadOffset = 0x20;  // after the mach header, the inner size and the event type
static const size_t kPayloadSize = 0x90;
static const size_t kTouchOffset = 0x30;    // the touch inside the first payload
static const size_t kTouchSize = 0x70;
static const size_t kMessageSize = kPayloadOffset + 2 * kPayloadSize;

static const uint32_t kDigitizerTarget = 0x32;
static const int32_t kDown = 1;
static const int32_t kUp = 2;
static const int32_t kShift = 0xE1;
static const int32_t kCommand = 0xE3;

static void writeU32(uint8_t *message, size_t offset, uint32_t value) { memcpy(message + offset, &value, sizeof value); }
static void writeU64(uint8_t *message, size_t offset, uint64_t value) { memcpy(message + offset, &value, sizeof value); }
static void writeDouble(uint8_t *message, size_t offset, double value) { memcpy(message + offset, &value, sizeof value); }

/// Sends a message the builders malloc'd and waits until the simulator accepts it. Returns an error or nil.
static NSString *sendMessage(void *message) {
  if (!message) return @"could not build the message";
  dispatch_semaphore_t sent = dispatch_semaphore_create(0);
  __block NSError *failure = nil;
  @try {
    [client sendWithMessage:message
               freeWhenDone:YES
            completionQueue:sendQueue
                 completion:^(NSError *error) {
                   failure = error;
                   dispatch_semaphore_signal(sent);
                 }];
  } @catch (NSException *exception) {
    return exception.reason ?: exception.name;
  }
  if (dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) return @"the simulator did not accept the event in time";
  return failure ? failure.localizedDescription : nil;
}

/// SimulatorKit's builder makes the touch; this repackages it as a single-finger touch
/// message the way idb does: two copies of the same payload, the second one marked as
/// the digitizer summary.
static void *touchMessage(CGPoint ratio, int32_t direction) {
  CGPoint point = ratio;
  uint8_t *source = buildMouseEvent(&point, NULL, kDigitizerTarget, (uint64_t)direction, CGSizeMake(1, 1), 0);
  if (!source) return NULL;
  writeDouble(source, 0x3C, ratio.x);
  writeDouble(source, 0x44, ratio.y);

  uint8_t *message = calloc(1, kMessageSize);
  writeU32(message, 0x18, (uint32_t)kPayloadSize);
  message[0x1C] = 2;                                // single touch
  writeU32(message, kPayloadOffset, 0xB);           // digitizer event
  writeU64(message, kPayloadOffset + 0x4, mach_absolute_time());
  memcpy(message + kTouchOffset, source + kTouchOffset, kTouchSize);
  free(source);

  memcpy(message + kPayloadOffset + kPayloadSize, message + kPayloadOffset, kPayloadSize);
  writeU32(message, kPayloadOffset + kPayloadSize + 0x10, 1);
  writeU32(message, kPayloadOffset + kPayloadSize + 0x14, 2);
  return message;
}

static xpc_object_t keyboardMessage(uint64_t usage, uint64_t state, bool barrier) {
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usageCode", usage);
  xpc_dictionary_set_uint64(payload, "state", state);
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", "IndigoKeyboardButtonEvent");
  xpc_dictionary_set_bool(message, "isBarrier", barrier);
  xpc_dictionary_set_string(message, "featureIdentifier", kKeyboardServiceName);
  xpc_dictionary_set_value(message, "payload", payload);
  return message;
}

/// Sends a barrier (a key-up for usage 0, which the guest ignores) and waits for the
/// reply, which means the service has received every key sent before it. Returns an
/// error or nil.
static NSString *keyboardBarrier(xpc_connection_t connection, int64_t timeoutMs) {
  dispatch_semaphore_t replied = dispatch_semaphore_create(0);
  __block BOOL failed = NO;
  xpc_connection_send_message_with_reply(connection, keyboardMessage(0, kUp, true), sendQueue, ^(xpc_object_t reply) {
    failed = xpc_get_type(reply) == XPC_TYPE_ERROR;
    dispatch_semaphore_signal(replied);
  });
  if (dispatch_semaphore_wait(replied, dispatch_time(DISPATCH_TIME_NOW, timeoutMs * NSEC_PER_MSEC)) != 0) {
    return @"the keyboard service did not answer";
  }
  return failed ? @"the keyboard service refused the connection" : nil;
}

/// Connects to dtuhidd's keyboard. Returns NO when the simulator has no such service,
/// or when it didn't answer after a few tries: it starts on demand, and right after a
/// slow boot launchd can take several seconds to bring it up.
static BOOL connectKeyboardService(id<JVDevice> device) {
  EndpointFromPort endpointFromPort = (EndpointFromPort)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  EnableSimToHost enableSimToHost = (EnableSimToHost)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpointFromPort || !enableSimToHost || ![(id)device respondsToSelector:@selector(lookup:error:)]) return NO;

  for (int attempt = 1; attempt <= 3; attempt++) {
    // A cancelled connection can't be reused, so every attempt starts from a fresh lookup.
    NSError *error = nil;
    mach_port_t port = [device lookup:@(kKeyboardServiceName) error:&error];
    if (port == MACH_PORT_NULL) return NO;
    xpc_object_t endpoint = endpointFromPort(port, 0, 0);
    if (!endpoint) return NO;
    xpc_connection_t connection = xpc_connection_create_from_endpoint((xpc_endpoint_t)endpoint);
    enableSimToHost(connection);
    xpc_connection_set_event_handler(connection, ^(__unused xpc_object_t event) {});
    xpc_connection_activate(connection);
    if (!keyboardBarrier(connection, 3000)) {
      keyboardService = connection;
      return YES;
    }
    xpc_connection_cancel(connection);
    if (attempt < 3) sleep(1);
  }
  return NO;
}

/// Whether this CoreSimulator (1155.4 and later, from Xcode 27) ignores key presses sent
/// to the HID port, so falling back to it would type nothing.
static BOOL legacyKeyboardIgnored(void) {
  NSBundle *bundle = [NSBundle bundleWithPath:@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework"];
  NSString *version = bundle.infoDictionary[@"CFBundleVersion"] ?: @"0";
  return [version compare:@"1155.4" options:NSNumericSearch] != NSOrderedAscending;
}

static NSString *sendKey(int32_t usage, int32_t direction) {
  if (keyboardService) {
    xpc_connection_send_message(keyboardService, keyboardMessage((uint64_t)usage, (uint64_t)direction, false));
    return nil;
  }
  return sendMessage(buildKeyboardEvent(usage, direction));
}

static NSString *tap(CGPoint ratio, useconds_t holdMs) {
  NSString *error = sendMessage(touchMessage(ratio, kDown));
  if (error) return error;
  usleep(holdMs * 1000);
  return sendMessage(touchMessage(ratio, kUp));
}

static NSString *press(int32_t usage, BOOL shift, BOOL command) {
  NSString *error = nil;
  if (shift && (error = sendKey(kShift, kDown))) return error;
  if (command && (error = sendKey(kCommand, kDown))) return error;
  if ((error = sendKey(usage, kDown))) return error;
  if ((error = sendKey(usage, kUp))) return error;
  if (command && (error = sendKey(kCommand, kUp))) return error;
  if (shift && (error = sendKey(kShift, kUp))) return error;
  return nil;
}

/// Waits until the service has received the keys sent so far, when the transport can tell.
static NSString *finishTyping(void) {
  return keyboardService ? keyboardBarrier(keyboardService, 2000) : nil;
}

/// The USB HID usage for a printable ASCII character on a US keyboard, or 0 if there is none.
static int32_t usageFor(char c, BOOL *shift) {
  static const char *unshifted = "abcdefghijklmnopqrstuvwxyz1234567890";
  static const char *symbols = "-=[]\\#;'`,./";            // usages 0x2D-0x38
  static const char *shiftedSymbols = "_+{}|~:\"~<>?";
  static const char *shiftedDigits = "!@#$%^&*()";         // shift + 1..0
  *shift = NO;
  if (c >= 'A' && c <= 'Z') { *shift = YES; c = c - 'A' + 'a'; }
  const char *found = strchr(unshifted, c);
  if (c && found) return 0x04 + (int32_t)(found - unshifted);
  if (c == ' ') return 0x2C;
  if (c == '\n') return 0x28;
  if (c == '\t') return 0x2B;
  if (c && (found = strchr(shiftedDigits, c))) { *shift = YES; return 0x1E + (int32_t)(found - shiftedDigits); }
  if (c && c != '#' && c != '~' && (found = strchr(symbols, c))) return 0x2D + (int32_t)(found - symbols);
  if (c && (found = strchr(shiftedSymbols, c)) && c != '~') { *shift = YES; return 0x2D + (int32_t)(found - shiftedSymbols); }
  if (c == '~') { *shift = YES; return 0x35; }
  return 0;
}

static NSString *typeCharacters(NSString *text) {
  const char *characters = text.UTF8String;
  for (size_t i = 0; characters[i]; i++) {
    BOOL shift = NO;
    int32_t usage = usageFor(characters[i], &shift);
    if (!usage) return [NSString stringWithFormat:@"cannot type the character at position %zu", i];
    NSString *error = press(usage, shift, NO);
    if (error) return error;
  }
  return nil;
}

static void *symbol(void *handle, const char *name) {
  void *found = dlsym(handle, name);
  if (!found) {
    fprintf(stdout, "error SimulatorKit has no %s\n", name);
    exit(1);
  }
  return found;
}

static void fail(NSString *reason) {
  fprintf(stdout, "error %s\n", reason.UTF8String);
  fflush(stdout);
  exit(1);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc != 3) fail(@"usage: jevvium-hid <developer-dir> <udid>");
    NSString *developerDir = @(argv[1]);
    NSString *udid = @(argv[2]);

    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
      fail(@"CoreSimulator is not installed");
    }
    // Xcode 27 moved SimulatorKit to SharedFrameworks; earlier versions keep it in PrivateFrameworks.
    NSArray<NSString *> *candidates = @[
      [developerDir stringByAppendingPathComponent:@"../SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
      [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
    ];
    void *simulatorKit = NULL;
    for (NSString *path in candidates) {
      if ((simulatorKit = dlopen(path.stringByStandardizingPath.fileSystemRepresentation, RTLD_NOW))) break;
    }
    if (!simulatorKit) fail(@"SimulatorKit was not found in this Xcode");
    buildMouseEvent = (MouseEventBuilder)symbol(simulatorKit, "IndigoHIDMessageForMouseNSEvent");
    buildKeyboardEvent = (KeyboardBuilder)symbol(simulatorKit, "IndigoHIDMessageForKeyboardArbitrary");

    NSError *error = nil;
    Class contextClass = NSClassFromString(@"SimServiceContext");
    id<JVServiceContext> context = [(id)contextClass sharedServiceContextForDeveloperDir:developerDir error:&error];
    id<JVDeviceSet> deviceSet = [context defaultDeviceSetWithError:&error];
    if (!deviceSet) fail([NSString stringWithFormat:@"no simulator device set: %@", error.localizedDescription]);

    id<JVDevice> device = nil;
    for (id<JVDevice> candidate in deviceSet.devices) {
      if ([candidate.UDID.UUIDString isEqualToString:udid.uppercaseString]) device = candidate;
    }
    if (!device) fail([NSString stringWithFormat:@"no simulator with UDID %@", udid]);
    if ([(id)device respondsToSelector:@selector(stateString)] && ![device.stateString isEqualToString:@"Booted"]) {
      fail(@"the simulator is not booted");
    }

    if ([(id)device respondsToSelector:@selector(setHardwareKeyboardEnabled:keyboardType:error:)]) {
      [device setHardwareKeyboardEnabled:YES keyboardType:0 error:NULL];
    }

    Class clientClass = objc_lookUpClass("SimulatorKit.SimDeviceLegacyHIDClient");
    if (!clientClass) fail(@"SimulatorKit has no HID client");
    client = [[clientClass alloc] initWithDevice:device error:&error];
    if (!client) fail([NSString stringWithFormat:@"could not connect to the simulator: %@", error.localizedDescription]);
    sendQueue = dispatch_queue_create("jevvium.hid", DISPATCH_QUEUE_SERIAL);
    BOOL modernKeyboard = connectKeyboardService(device);
    BOOL legacyIgnored = !modernKeyboard && legacyKeyboardIgnored();
    keyboardAvailable = !legacyIgnored;

    printf("ready %s\n", modernKeyboard ? "dtuhidd-keyboard" : legacyIgnored ? "no-keyboard" : "legacy-keyboard");

    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) > 0) {
      @autoreleasepool {
        NSString *command = [[NSString stringWithUTF8String:line] stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];
        NSString *result = nil;
        if ([command hasPrefix:@"tap "]) {
          NSArray<NSString *> *parts = [command componentsSeparatedByString:@" "];
          if (parts.count < 3) result = @"tap needs x and y";
          else result = tap(CGPointMake(parts[1].doubleValue, parts[2].doubleValue),
                            parts.count > 3 ? (useconds_t)parts[3].intValue : 20);
        } else if (!keyboardAvailable && ([command hasPrefix:@"text "] || [command hasPrefix:@"key "] ||
                                          [command isEqualToString:@"clear"])) {
          result = @"no keyboard: this simulator ignores the HID port for keys and its keyboard service did not answer";
        } else if ([command hasPrefix:@"text "]) {
          result = typeCharacters([command substringFromIndex:5]);
          if (!result) result = finishTyping();
        } else if ([command hasPrefix:@"key "]) {
          NSArray<NSString *> *parts = [command componentsSeparatedByString:@" "];
          result = press(parts[1].intValue, parts.count > 2 && [parts[2] isEqualToString:@"shift"], NO);
          if (!result) result = finishTyping();
        } else if ([command isEqualToString:@"clear"]) {
          result = press(0x04, NO, YES);                   // command-A
          if (!result) result = press(0x2A, NO, NO);       // delete
          if (!result) result = finishTyping();
        } else if ([command isEqualToString:@"quit"]) {
          break;
        } else {
          result = [NSString stringWithFormat:@"unknown command: %@", command];
        }
        if (result) printf("error %s\n", result.UTF8String);
        else printf("ok\n");
      }
    }
    free(line);
  }
  return 0;
}

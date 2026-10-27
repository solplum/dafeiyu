#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static int emit(const char *code) {
    if (strcmp(code, "READY") == 0) {
        fputs("{\"ok\":true,\"code\":\"READY\"}\n", stdout);
        return 0;
    }
    if (strcmp(code, "UNTRUSTED") == 0) fputs("{\"ok\":false,\"code\":\"UNTRUSTED\"}\n", stdout);
    else if (strcmp(code, "UNCONFIRMED") == 0) fputs("{\"ok\":false,\"code\":\"UNCONFIRMED\"}\n", stdout);
    else fputs("{\"ok\":false,\"code\":\"UNAVAILABLE\"}\n", stdout);
    return 1;
}

typedef enum { ReadTrue, ReadFalse, ReadUnsupported, ReadDenied, ReadUnconfirmed } Readback;
static Readback readBoolean(AXUIElementRef application, CFStringRef attribute) {
    CFTypeRef value = NULL;
    AXError status = AXUIElementCopyAttributeValue(application, attribute, &value);
    Readback readback = status == kAXErrorAttributeUnsupported ? ReadUnsupported
        : status == kAXErrorAPIDisabled ? ReadDenied : ReadUnconfirmed;
    if (status == kAXErrorSuccess && value != NULL && CFGetTypeID(value) == CFBooleanGetTypeID())
        readback = CFBooleanGetValue((CFBooleanRef)value) ? ReadTrue : ReadFalse;
    if (value != NULL) CFRelease(value);
    return readback;
}

static const char *settleManualAccessibility(AXUIElementRef axApplication,
    NSRunningApplication *application, CFStringRef manualAttribute) {
    // Electron 44 delays enabling the tree for two seconds after the final
    // setter. Never resend setters while waiting: that restarts its debounce.
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 3.5;
    Readback manual = ReadUnconfirmed;
    while (YES) {
        if (application.terminated) return "UNCONFIRMED";
        if (!AXIsProcessTrusted()) return "UNTRUSTED";
        manual = readBoolean(axApplication, manualAttribute);
        if (manual == ReadDenied) return "UNTRUSTED";
        if (manual == ReadTrue) return application.terminated ? "UNCONFIRMED"
            : !AXIsProcessTrusted() ? "UNTRUSTED" : "READY";
        NSTimeInterval remaining = deadline - NSProcessInfo.processInfo.systemUptime;
        if (remaining <= 0) break;
        [NSThread sleepForTimeInterval:MIN(0.1, remaining)];
    }
    if (application.terminated) return "UNCONFIRMED";
    if (!AXIsProcessTrusted()) return "UNTRUSTED";
    // The Electron getter compares its mode to kAXModeComplete exactly, while
    // enabling it may add kScreenReader too. A false/unsupported getter cannot
    // disprove an accepted initializer; only the subsequent Orca nonce test
    // proves real input and clicks. Other AX read failures remain unconfirmed.
    return manual == ReadFalse || manual == ReadUnsupported ? "READY" : "UNCONFIRMED";
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return emit("UNAVAILABLE");
        long rawPid = 0;
        if (strcmp(argv[1], "current-dsh") == 0) {
            NSArray<NSRunningApplication *> *matches = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.deepseek.dsh"];
            NSMutableArray<NSRunningApplication *> *live = [NSMutableArray array];
            for (NSRunningApplication *candidate in matches) {
                if (!candidate.terminated && [candidate.bundleIdentifier isEqualToString:@"com.deepseek.dsh"]) [live addObject:candidate];
            }
            if (live.count != 1) return emit("UNAVAILABLE");
            rawPid = live.firstObject.processIdentifier;
        } else {
            if (argv[1][0] < '1' || argv[1][0] > '9') return emit("UNAVAILABLE");
            for (const char *c = argv[1]; *c != '\0'; c++) if (*c < '0' || *c > '9') return emit("UNAVAILABLE");
            errno = 0;
            char *end = NULL;
            rawPid = strtol(argv[1], &end, 10);
            if (errno != 0 || end == NULL || *end != '\0') return emit("UNAVAILABLE");
        }
        if (rawPid <= 0 || rawPid > INT_MAX) return emit("UNAVAILABLE");
        NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)rawPid];
        if (application == nil || application.terminated || ![application.bundleIdentifier isEqualToString:@"com.deepseek.dsh"])
            return emit("UNAVAILABLE");
        // This read never opens System Settings or requests a TCC permission.
        if (!AXIsProcessTrusted()) return emit("UNTRUSTED");
        AXUIElementRef axApplication = AXUIElementCreateApplication((pid_t)rawPid);
        if (axApplication == NULL) return emit("UNCONFIRMED");
        // Keep each synchronous AX message short enough for the helper's
        // eight-second outer deadline, including its bounded settling window.
        AXUIElementSetMessagingTimeout(axApplication, 0.25f);
        CFStringRef manualAttribute = CFSTR("AXManualAccessibility");
        CFStringRef enhancedAttribute = CFSTR("AXEnhancedUserInterface");
        AXError manualSet = AXUIElementSetAttributeValue(axApplication, manualAttribute, kCFBooleanTrue);
        // Enhanced mode is best effort. Initializing the tree is not proof of
        // input or clicks; the caller must still use Orca and read its result.
        AXError enhancedSet = AXUIElementSetAttributeValue(axApplication, enhancedAttribute, kCFBooleanTrue);
        const char *code = manualSet == kAXErrorAPIDisabled || enhancedSet == kAXErrorAPIDisabled ? "UNTRUSTED"
            : manualSet != kAXErrorSuccess ? "UNCONFIRMED"
            : settleManualAccessibility(axApplication, application, manualAttribute);
        CFRelease(axApplication);
        return emit(code);
    }
}

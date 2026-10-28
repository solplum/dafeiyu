#import <AppKit/AppKit.h>
#include <stdio.h>
#include <unistd.h>

@interface DFYDesktopFixture : NSObject <NSApplicationDelegate>
@property(strong) NSWindow *window;
@property(strong) NSTextField *input;
@property(strong) NSTextField *message;
@end

@implementation DFYDesktopFixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 600, 200)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"本机桌面能力安全测试";
    self.window.releasedWhenClosed = NO;
    NSTextField *intro = [NSTextField labelWithString:@"仅验证此临时窗口的输入、点击与回读，不访问其他应用内容。"];
    intro.frame = NSMakeRect(20, 150, 560, 26);
    [self.window.contentView addSubview:intro];
    self.input = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 100, 360, 30)];
    self.input.stringValue = @"";
    self.input.accessibilityLabel = @"本机能力验证输入";
    [self.window.contentView addSubview:self.input];
    NSButton *button = [NSButton buttonWithTitle:@"确认本机能力测试" target:self action:@selector(confirm:)];
    button.frame = NSMakeRect(395, 100, 185, 30);
    [self.window.contentView addSubview:button];
    self.message = [NSTextField labelWithString:@""];
    self.message.frame = NSMakeRect(20, 40, 560, 40);
    [self.window.contentView addSubview:self.message];
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.window.visible) { [NSApp terminate:nil]; return; }
        fprintf(stdout, "{\"ready\":true,\"pid\":%d}\n", getpid());
        fflush(stdout);
    });
}
- (void)confirm:(id)sender {
    (void)sender;
    self.message.stringValue = [@"本机界面验证已收到 " stringByAppendingString:self.input.stringValue];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    (void)sender;
    return YES;
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) DFYDesktopFixture *delegate = [DFYDesktopFixture new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}

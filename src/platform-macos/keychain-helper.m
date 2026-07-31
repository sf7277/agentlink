#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int fail(NSString *message, int code) {
    NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    [[NSFileHandle fileHandleWithStandardError] writeData:data];
    return code;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 3 || argc > 4) {
            return fail(@"usage: keychain-helper <put|get|delete> <service> <account> | list <service>", 1);
        }
        NSString *operation = [NSString stringWithUTF8String:argv[1]];
        NSString *service = [NSString stringWithUTF8String:argv[2]];
        if ([operation isEqualToString:@"list"]) {
            if (argc != 3) return fail(@"list accepts only a service", 1);
            NSDictionary *query = @{
                (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                (__bridge id)kSecAttrService: service,
                (__bridge id)kSecReturnAttributes: @YES,
                (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll
            };
            CFTypeRef result = NULL;
            OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
            if (status == errSecItemNotFound) {
                [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"[]" dataUsingEncoding:NSUTF8StringEncoding]];
                return 0;
            }
            if (status != errSecSuccess || result == NULL) {
                return fail(
                    [NSString stringWithFormat:@"Keychain list failed with OSStatus %d", (int)status],
                    1
                );
            }
            id bridged = CFBridgingRelease(result);
            NSArray *items = [bridged isKindOfClass:[NSArray class]] ? bridged : @[bridged];
            NSMutableArray<NSString *> *accounts = [NSMutableArray array];
            for (NSDictionary *item in items) {
                NSString *account = item[(__bridge id)kSecAttrAccount];
                if ([account isKindOfClass:[NSString class]]) [accounts addObject:account];
            }
            NSData *json = [NSJSONSerialization dataWithJSONObject:accounts options:0 error:nil];
            [[NSFileHandle fileHandleWithStandardOutput] writeData:json];
            return 0;
        }
        if (argc != 4) return fail(@"credential operation requires an account", 1);
        NSString *account = [NSString stringWithUTF8String:argv[3]];
        NSDictionary *base = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: service,
            (__bridge id)kSecAttrAccount: account
        };

        if ([operation isEqualToString:@"put"]) {
            NSData *secret = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            if (secret.length == 0) return fail(@"credential secret must not be empty", 1);
            OSStatus status = SecItemUpdate(
                (__bridge CFDictionaryRef)base,
                (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: secret}
            );
            if (status == errSecItemNotFound) {
                NSMutableDictionary *add = [base mutableCopy];
                add[(__bridge id)kSecValueData] = secret;
                add[(__bridge id)kSecAttrAccessible] =
                    (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
                status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
            }
            if (status != errSecSuccess) {
                return fail(
                    [NSString stringWithFormat:@"Keychain put failed with OSStatus %d", (int)status],
                    1
                );
            }
            return 0;
        }

        if ([operation isEqualToString:@"get"]) {
            NSMutableDictionary *query = [base mutableCopy];
            query[(__bridge id)kSecReturnData] = @YES;
            query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
            CFTypeRef result = NULL;
            OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
            if (status == errSecItemNotFound) return 44;
            if (status != errSecSuccess || result == NULL) {
                return fail(
                    [NSString stringWithFormat:@"Keychain get failed with OSStatus %d", (int)status],
                    1
                );
            }
            NSData *secret = CFBridgingRelease(result);
            [[NSFileHandle fileHandleWithStandardOutput] writeData:secret];
            return 0;
        }

        if ([operation isEqualToString:@"delete"]) {
            OSStatus status = SecItemDelete((__bridge CFDictionaryRef)base);
            if (status == errSecItemNotFound) return 44;
            if (status != errSecSuccess) {
                return fail(
                    [NSString stringWithFormat:@"Keychain delete failed with OSStatus %d", (int)status],
                    1
                );
            }
            return 0;
        }

        return fail(@"unsupported Keychain operation", 1);
    }
}

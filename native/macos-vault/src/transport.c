#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define FRAME_LIMIT 16384

int vault_self_cdhash(char *output, size_t capacity) {
    if (capacity < 41) return -1;
    SecCodeRef code = NULL;
    CFDictionaryRef info = NULL;
    OSStatus result = SecCodeCopySelf(0, &code);
    if (result == 0) result = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
    if (result == 0) {
        CFDataRef digest = CFDictionaryGetValue(info, kSecCodeInfoUnique);
        if (!digest || CFGetTypeID(digest) != CFDataGetTypeID() || CFDataGetLength(digest) != 20) result = -1;
        else {
            const UInt8 *bytes = CFDataGetBytePtr(digest);
            const char hex[] = "0123456789abcdef";
            for (size_t i = 0; i < 20; i++) {
                output[i * 2] = hex[bytes[i] >> 4]; output[i * 2 + 1] = hex[bytes[i] & 15];
            }
            output[40] = 0;
        }
    }
    if (info) CFRelease(info);
    if (code) CFRelease(code);
    return result;
}

static int code_policy(SecStaticCodeRef code) {
    CFDictionaryRef info = NULL;
    OSStatus result = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
    if (result == 0) {
        CFNumberRef flags = CFDictionaryGetValue(info, kSecCodeInfoFlags);
        int value = 0;
        if (!flags || CFGetTypeID(flags) != CFNumberGetTypeID() ||
            !CFNumberGetValue(flags, kCFNumberIntType, &value) || !(value & 0x10000)) result = -1;
        CFDictionaryRef entitlements = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
        // The helper and its clients must not allow injection into approved code.
        const CFStringRef forbidden[] = {
            CFSTR("com.apple.security.get-task-allow"), CFSTR("get-task-allow"),
            CFSTR("com.apple.security.cs.disable-library-validation"),
            CFSTR("com.apple.security.cs.allow-dyld-environment-variables"),
            CFSTR("com.apple.security.cs.allow-unsigned-executable-memory"),
            CFSTR("com.apple.security.cs.disable-executable-page-protection"),
            CFSTR("com.apple.security.cs.allow-jit")
        };
        if (entitlements) {
            if (CFGetTypeID(entitlements) != CFDictionaryGetTypeID()) result = -1;
            else for (size_t i = 0; i < sizeof(forbidden) / sizeof(forbidden[0]); i++) {
                CFTypeRef enabled = CFDictionaryGetValue(entitlements, forbidden[i]);
                if (enabled && !CFEqual(enabled, kCFBooleanFalse)) result = -1;
            }
        }
    }
    if (info) CFRelease(info);
    return result;
}
int vault_message_authorized(xpc_object_t message, const char *text) {
    SecCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    CFStringRef string = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
    OSStatus result = SecRequirementCreateWithString(string, 0, &requirement);
    CFRelease(string);
    if (result == 0) result = SecCodeCreateWithXPCMessage(message, 0, &code);
    if (result == 0) result = SecCodeCheckValidity(code, 0, requirement);
    if (result == 0) result = code_policy(code);
    if (code) CFRelease(code);
    if (requirement) CFRelease(requirement);
    return result;
}

int vault_file_authorized(const char *path, const char *text) {
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), false);
    CFStringRef string = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
    OSStatus result = SecRequirementCreateWithString(string, 0, &requirement);
    CFRelease(string);
    if (!url) result = -1;
    if (result == 0) result = SecStaticCodeCreateWithPath(url, 0, &code);
    if (result == 0) result = SecStaticCodeCheckValidity(code,
        kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSNoNetworkAccess, requirement);
    if (result == 0) result = code_policy(code);
    if (url) CFRelease(url);
    if (code) CFRelease(code);
    if (requirement) CFRelease(requirement);
    return result;
}

struct pending_reply { atomic_uint refs; dispatch_semaphore_t semaphore; xpc_object_t reply; };
static void release_pending(struct pending_reply *pending) {
    if (atomic_fetch_sub(&pending->refs, 1) == 1) {
        if (pending->reply) xpc_release(pending->reply);
        dispatch_release(pending->semaphore);
        free(pending);
    }
}

static xpc_object_t exchange(xpc_connection_t connection, xpc_object_t message) {
    struct pending_reply *pending = calloc(1, sizeof(*pending));
    if (!pending) return NULL;
    atomic_init(&pending->refs, 2);
    pending->semaphore = dispatch_semaphore_create(0);
    xpc_connection_send_message_with_reply(connection, message,
        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^(xpc_object_t reply) {
            pending->reply = xpc_retain(reply);
            dispatch_semaphore_signal(pending->semaphore);
            release_pending(pending);
        });
    xpc_object_t reply = NULL;
    if (dispatch_semaphore_wait(pending->semaphore, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0)
        reply = xpc_retain(pending->reply);
    release_pending(pending);
    return reply;
}

static bool start_client(xpc_connection_t connection, const char *requirement) {
    if (!connection) return false;
    int result = xpc_connection_set_peer_code_signing_requirement(connection, requirement);
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) { (void)event; });
    xpc_connection_activate(connection);
    return result == 0;
}

int vault_client_request(const char *service, const char *requirement,
    const void *proof, size_t proof_len, const void *request, size_t request_len,
    void *output, size_t capacity, size_t *length) {
    if (proof_len > FRAME_LIMIT || request_len > FRAME_LIMIT) return -1;
    int result = -1;
    xpc_connection_t discovery = xpc_connection_create_mach_service(service, NULL, 0);
    xpc_connection_t session = NULL;
    xpc_object_t hello = xpc_dictionary_create(NULL, NULL, 0), accepted = NULL, response = NULL;
    xpc_object_t operation = xpc_dictionary_create(NULL, NULL, 0);
    if (!start_client(discovery, requirement)) goto done;
    xpc_dictionary_set_data(hello, "body", proof, proof_len);
    accepted = exchange(discovery, hello);
    if (!accepted || xpc_get_type(accepted) != XPC_TYPE_DICTIONARY ||
        vault_message_authorized(accepted, requirement) != 0) goto done;
    xpc_object_t endpoint = xpc_dictionary_get_value(accepted, "endpoint");
    if (!endpoint || xpc_get_type(endpoint) != XPC_TYPE_ENDPOINT) goto done;
    // Anonymous endpoints cannot reconnect to a replacement named service.
    // Only a verified server can supply this endpoint; hello contains no secret.
    session = xpc_connection_create_from_endpoint(endpoint);
    if (!start_client(session, requirement)) goto done;
    xpc_dictionary_set_data(operation, "body", request, request_len);
    response = exchange(session, operation);
    if (!response || xpc_get_type(response) != XPC_TYPE_DICTIONARY ||
        vault_message_authorized(response, requirement) != 0) goto done;
    size_t size = 0;
    const void *bytes = xpc_dictionary_get_data(response, "body", &size);
    if (!bytes || size == 0 || size > capacity) goto done;
    memcpy(output, bytes, size);
    *length = size;
    result = 0;
done:
    if (session) { xpc_connection_cancel(session); xpc_release(session); }
    if (discovery) { xpc_connection_cancel(discovery); xpc_release(discovery); }
    if (accepted) xpc_release(accepted);
    if (response) xpc_release(response);
    xpc_release(hello);
    xpc_release(operation);
    return result;
}

typedef size_t (*handler_t)(xpc_object_t, const void *, size_t, bool, void *, size_t);

static void install_listener(xpc_connection_t listener, bool hello, xpc_endpoint_t endpoint, handler_t handler) {
    xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
        if (xpc_get_type(event) != XPC_TYPE_CONNECTION) return;
        xpc_connection_t peer = (xpc_connection_t)event;
        xpc_retain(peer);
        xpc_connection_set_target_queue(peer, dispatch_get_main_queue());
        xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
            if (message == XPC_ERROR_CONNECTION_INVALID) { xpc_release(peer); return; }
            if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) return;
            size_t length = 0;
            const void *bytes = xpc_dictionary_get_data(message, "body", &length);
            xpc_object_t response = xpc_dictionary_create_reply(message);
            if (!response) return;
            unsigned char output[FRAME_LIMIT];
            size_t written = 0;
            if (bytes && length > 0 && length <= FRAME_LIMIT)
                written = handler(message, bytes, length, hello, output, sizeof(output));
            if (written > 0 && written <= FRAME_LIMIT) {
                if (hello) xpc_dictionary_set_value(response, "endpoint", endpoint);
                else xpc_dictionary_set_data(response, "body", output, written);
            }
            xpc_connection_send_message(peer, response);
            xpc_release(response);
        });
        xpc_connection_activate(peer);
    });
    xpc_connection_activate(listener);
}

int vault_serve(const char *service, handler_t handler) {
    xpc_connection_t session = xpc_connection_create(NULL, dispatch_get_main_queue());
    if (!session) return -1;
    xpc_endpoint_t endpoint = xpc_endpoint_create(session);
    install_listener(session, false, NULL, handler);
    xpc_connection_t discovery = xpc_connection_create_mach_service(service,
        dispatch_get_main_queue(), XPC_CONNECTION_MACH_SERVICE_LISTENER);
    if (!discovery) return -1;
    install_listener(discovery, true, endpoint, handler);
    dispatch_main();
}

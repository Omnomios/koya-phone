#include "credential.hpp"
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <pwd.h>
#include <security/pam_appl.h>
#include <unistd.h>

struct Conversation {
    std::string user, current, next;
    bool changing = false;
    static int respond(int count, const pam_message **messages, pam_response **out, void *opaque) {
        auto &self = *static_cast<Conversation *>(opaque);
        if (count < 1 || count > PAM_MAX_NUM_MSG)
            return PAM_CONV_ERR;
        auto *responses = static_cast<pam_response *>(calloc(count, sizeof(pam_response)));
        if (!responses)
            return PAM_BUF_ERR;
        for (int i = 0; i < count; ++i) {
            const std::string *value = nullptr;
            if (messages[i]->msg_style == PAM_PROMPT_ECHO_OFF)
                value = self.changing ? &self.next : &self.current;
            else if (messages[i]->msg_style == PAM_PROMPT_ECHO_ON)
                value = &self.user;
            else if (messages[i]->msg_style != PAM_TEXT_INFO && messages[i]->msg_style != PAM_ERROR_MSG) {
                for (int j = 0; j < i; ++j)
                    if (responses[j].resp) {
                        OPENSSL_cleanse(responses[j].resp, strlen(responses[j].resp));
                        free(responses[j].resp);
                    }
                free(responses);
                return PAM_CONV_ERR;
            }
            if (value && !(responses[i].resp = strdup(value->c_str()))) {
                for (int j = 0; j < i; ++j)
                    if (responses[j].resp) {
                        OPENSSL_cleanse(responses[j].resp, strlen(responses[j].resp));
                        free(responses[j].resp);
                    }
                free(responses);
                return PAM_BUF_ERR;
            }
        }
        *out = responses;
        return PAM_SUCCESS;
    }
    ~Conversation() {
        Credential::erase(current);
        Credential::erase(next);
    }
};
static bool readSecret(std::string &out) {
    char byte;
    while (std::cin.get(byte)) {
        if (byte == '\n')
            return true;
        if (!byte || byte == '\r')
            return false;
        out += byte;
    }
    return false;
}
int main(int argc, char **) {
    // pkexec sets this to the authenticated caller; callers cannot choose an account.
    const char *caller = getenv("PKEXEC_UID");
    char *end = nullptr;
    unsigned long uid = caller ? strtoul(caller, &end, 10) : 0;
    if (argc != 1 || geteuid() != 0 || !caller || !*caller || !end || *end || !uid ||
        uid > std::numeric_limits<uid_t>::max())
        return 1;
    passwd *account = getpwuid(static_cast<uid_t>(uid));
    if (!account)
        return 1;
    Conversation conversation;
    conversation.user = account->pw_name;
    if (!readSecret(conversation.current) || !readSecret(conversation.next) || conversation.current.empty() ||
        conversation.next.empty())
        return 1;
    pam_conv conv{Conversation::respond, &conversation};
    pam_handle_t *handle = nullptr;
    int code = pam_start("koya-credential", conversation.user.c_str(), &conv, &handle);
    if (code == PAM_SUCCESS)
        code = pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK);
    if (code == PAM_SUCCESS)
        code = pam_acct_mgmt(handle, 0);
    if (code != PAM_SUCCESS) {
        if (handle)
            pam_end(handle, code);
        std::cout << "unchanged\n";
        return 2;
    }
    conversation.changing = true;
    code = pam_chauthtok(handle, 0);
    if (handle)
        pam_end(handle, code);
    // Never expose tokens or PAM's conversation text to logs or stdout.
    if (code == PAM_SUCCESS) {
        std::cout << "changed\n";
        return 0;
    }
    std::cout << "denied\n";
    return 3;
}

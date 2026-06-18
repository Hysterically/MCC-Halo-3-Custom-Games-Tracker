#include "http.h"

#include <curl/curl.h>

#include <mutex>

namespace {

void ensureGlobalInit() {
    static std::once_flag once;
    std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

size_t writeCb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

// Shared easy-handle defaults for every request shape.
void applyCommonOpts(CURL* curl, const std::string& url, HttpResponse& res) {
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &res.body);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "h3-tracker (https://github.com, 1.0)");
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
}

}  // namespace

HttpResponse httpRequest(const std::string& method, const std::string& url,
                         const std::vector<std::string>& headers, const std::string& body) {
    ensureGlobalInit();
    HttpResponse res;

    CURL* curl = curl_easy_init();
    if (!curl) {
        res.networkError = true;
        res.error = "curl_easy_init failed";
        return res;
    }

    applyCommonOpts(curl, url, res);

    if (method == "POST") {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    } else if (method == "GET") {
        curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
    } else {
        // PATCH / DELETE / etc.
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());
        if (!body.empty()) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
        }
    }

    struct curl_slist* hdrs = nullptr;
    for (const auto& h : headers) hdrs = curl_slist_append(hdrs, h.c_str());
    if (hdrs) curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);

    CURLcode rc = curl_easy_perform(curl);
    if (rc != CURLE_OK) {
        res.networkError = true;
        res.error = curl_easy_strerror(rc);
    } else {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &res.status);
    }

    if (hdrs) curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);
    return res;
}

HttpResponse httpPostMultipart(const std::string& url, const std::string& payloadJson,
                               const std::string& fileField, const std::string& filename,
                               const std::string& mimeType,
                               const std::vector<unsigned char>& fileData,
                               const std::string& method) {
    ensureGlobalInit();
    HttpResponse res;

    CURL* curl = curl_easy_init();
    if (!curl) {
        res.networkError = true;
        res.error = "curl_easy_init failed";
        return res;
    }
    applyCommonOpts(curl, url, res);

    curl_mime* mime = curl_mime_init(curl);
    curl_mimepart* part = curl_mime_addpart(mime);
    curl_mime_name(part, "payload_json");
    curl_mime_type(part, "application/json");
    curl_mime_data(part, payloadJson.c_str(), payloadJson.size());

    part = curl_mime_addpart(mime);
    curl_mime_name(part, fileField.c_str());
    curl_mime_filename(part, filename.c_str());
    curl_mime_type(part, mimeType.c_str());
    curl_mime_data(part, reinterpret_cast<const char*>(fileData.data()), fileData.size());

    curl_easy_setopt(curl, CURLOPT_MIMEPOST, mime);
    // CURLOPT_MIMEPOST implies POST; override the verb for multipart PATCH.
    if (method != "POST") curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());

    CURLcode rc = curl_easy_perform(curl);
    if (rc != CURLE_OK) {
        res.networkError = true;
        res.error = curl_easy_strerror(rc);
    } else {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &res.status);
    }

    curl_mime_free(mime);
    curl_easy_cleanup(curl);
    return res;
}

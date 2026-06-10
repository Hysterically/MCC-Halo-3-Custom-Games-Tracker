// Thin libcurl wrapper (Schannel TLS — uses the Windows certificate store, so
// no CA bundle ships). Enough surface for the handful of request shapes the app
// makes: Discord webhook POST/PATCH/DELETE, Discord REST, and the Hrana DB
// pipeline POST.
#pragma once
#include <string>
#include <vector>

struct HttpResponse {
    long status = 0;          // HTTP status code (0 if the request never completed)
    std::string body;         // response body
    bool ok() const { return status >= 200 && status < 300; }
    bool networkError = false;  // true if curl could not complete the request
    std::string error;          // curl error string when networkError
};

// method: "GET" | "POST" | "PATCH" | "DELETE". Extra headers are raw
// "Key: Value" strings. body is sent as-is (empty for GET/DELETE).
HttpResponse httpRequest(const std::string& method, const std::string& url,
                         const std::vector<std::string>& headers = {},
                         const std::string& body = "");

// multipart/form-data POST with a JSON part (`payload_json`) and one file
// part — the shape Discord webhooks expect for attachment uploads.
HttpResponse httpPostMultipart(const std::string& url, const std::string& payloadJson,
                               const std::string& fileField, const std::string& filename,
                               const std::string& mimeType,
                               const std::vector<unsigned char>& fileData);

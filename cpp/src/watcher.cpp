#include "watcher.h"

#include <windows.h>

#include <iostream>
#include <unordered_map>

#include "util.h"

namespace {

std::wstring toW(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    return w;
}
std::string toUtf8(const wchar_t* p, size_t lenChars) {
    int n = WideCharToMultiByte(CP_UTF8, 0, p, static_cast<int>(lenChars), nullptr, 0, nullptr,
                                nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, p, static_cast<int>(lenChars), s.data(), n, nullptr, nullptr);
    return s;
}

bool isCarnage(const std::string& name) {
    std::string l = util::toLower(name);
    return l.find("carnage") != std::string::npos && l.size() >= 4 &&
           l.compare(l.size() - 4, 4, ".xml") == 0;
}

// Current size + mtime of a file (both 0 if missing).
bool statFile(const std::wstring& path, unsigned long long& size, unsigned long long& mtime) {
    WIN32_FILE_ATTRIBUTE_DATA fa{};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &fa)) return false;
    size = (static_cast<unsigned long long>(fa.nFileSizeHigh) << 32) | fa.nFileSizeLow;
    ULARGE_INTEGER t;
    t.LowPart = fa.ftLastWriteTime.dwLowDateTime;
    t.HighPart = fa.ftLastWriteTime.dwHighDateTime;
    mtime = t.QuadPart;
    return true;
}

struct Pending {
    std::wstring fullPath;
    std::string utf8Path;
    unsigned long long size = 0;
    unsigned long long mtime = 0;
    unsigned long long stableSince = 0;  // GetTickCount64 of last observed change
};

}  // namespace

void watchDirectory(const std::string& dir, std::atomic<bool>& stop,
                    const std::function<void(const std::string&)>& onStableFile) {
    std::wstring dirW = toW(dir);
    HANDLE hDir = CreateFileW(dirW.c_str(), FILE_LIST_DIRECTORY,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                              nullptr);
    if (hDir == INVALID_HANDLE_VALUE) {
        std::cerr << "[watch] cannot open directory: " << dir << " (error "
                  << GetLastError() << ")\n";
        return;
    }

    OVERLAPPED ov{};
    ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::vector<BYTE> buf(64 * 1024);
    bool readPending = false;
    std::unordered_map<std::wstring, Pending> pending;

    const DWORD filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE |
                         FILE_NOTIFY_CHANGE_SIZE;

    auto touch = [&](const std::wstring& fileName) {
        std::string name = toUtf8(fileName.c_str(), fileName.size());
        if (!isCarnage(name)) return;
        std::wstring full = dirW + L"\\" + fileName;
        Pending& p = pending[full];
        p.fullPath = full;
        p.utf8Path = toUtf8(full.c_str(), full.size());
        statFile(full, p.size, p.mtime);
        p.stableSince = GetTickCount64();  // reset stability timer on every change
    };

    while (!stop.load()) {
        if (!readPending) {
            ResetEvent(ov.hEvent);
            DWORD br = 0;
            if (ReadDirectoryChangesW(hDir, buf.data(), static_cast<DWORD>(buf.size()), FALSE,
                                      filter, &br, &ov, nullptr)) {
                readPending = true;
            } else {
                std::cerr << "[watch] ReadDirectoryChangesW failed (error " << GetLastError()
                          << ")\n";
                break;
            }
        }

        DWORD w = WaitForSingleObject(ov.hEvent, WATCH_POLL_MS);
        if (w == WAIT_OBJECT_0) {
            DWORD bytes = 0;
            if (GetOverlappedResult(hDir, &ov, &bytes, FALSE) && bytes > 0) {
                BYTE* base = buf.data();
                for (;;) {
                    auto* fni = reinterpret_cast<FILE_NOTIFY_INFORMATION*>(base);
                    std::wstring fileName(fni->FileName,
                                          fni->FileNameLength / sizeof(WCHAR));
                    if (fni->Action != FILE_ACTION_REMOVED &&
                        fni->Action != FILE_ACTION_RENAMED_OLD_NAME)
                        touch(fileName);
                    if (fni->NextEntryOffset == 0) break;
                    base += fni->NextEntryOffset;
                }
            }
            readPending = false;
        }

        // Stability poll: emit files whose size+mtime have held for the threshold.
        unsigned long long now = GetTickCount64();
        for (auto it = pending.begin(); it != pending.end();) {
            Pending& p = it->second;
            unsigned long long sz = 0, mt = 0;
            if (!statFile(p.fullPath, sz, mt)) {
                it = pending.erase(it);  // gone
                continue;
            }
            if (sz != p.size || mt != p.mtime) {
                p.size = sz;
                p.mtime = mt;
                p.stableSince = now;  // changed — restart the timer
                ++it;
            } else if (now - p.stableSince >= static_cast<unsigned long long>(WATCH_STABILITY_MS)) {
                std::string path = p.utf8Path;
                it = pending.erase(it);
                onStableFile(path);
            } else {
                ++it;
            }
        }
    }

    CancelIo(hDir);
    if (ov.hEvent) CloseHandle(ov.hEvent);
    CloseHandle(hDir);
}

#include "csr_gfx.h"

#include <windows.h>
#include <objidl.h>

#include <algorithm>
#include <cwctype>
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "csr_assets.h"

#pragma comment(lib, "gdiplus.lib")

using namespace Gdiplus;

namespace {

std::wstring lowerW(std::wstring s) {
    for (auto& c : s) c = towlower(c);
    return s;
}

// Process-wide private font collection holding the embedded Blender Pro faces,
// plus the families enumerated from it (kept alive for the FontFamily pointers).
// FontFamily isn't copyable, so the enumerated array is held by raw owning ptr.
struct BlenderFonts {
    PrivateFontCollection pfc;
    std::unique_ptr<FontFamily[]> families;  // owned by pfc; storage kept here
    int familyCount = 0;
    std::unique_ptr<FontFamily> systemFallback;
    BlenderFace regular{nullptr, 0};   // FontStyleRegular = 0
    BlenderFace bold{nullptr, 1};      // FontStyleBold = 1
};

BlenderFonts& fonts() {
    static BlenderFonts f;
    static std::once_flag once;
    std::call_once(once, [] {
        f.pfc.AddMemoryFont(BLENDER_PRO_MEDIUM, sizeof(BLENDER_PRO_MEDIUM));
        f.pfc.AddMemoryFont(BLENDER_PRO_BOLD, sizeof(BLENDER_PRO_BOLD));

        int count = f.pfc.GetFamilyCount();
        if (count > 0) {
            f.families = std::make_unique<FontFamily[]>(count);
            int found = 0;
            f.pfc.GetFamilies(count, f.families.get(), &found);
            f.familyCount = found;
        }

        const FontFamily* blenderRegular = nullptr;
        const FontFamily* blenderBold = nullptr;
        const FontFamily* anyBlender = nullptr;
        for (int i = 0; i < f.familyCount; ++i) {
            const FontFamily& fam = f.families[i];
            WCHAR name[LF_FACESIZE] = {0};
            if (fam.GetFamilyName(name) != Ok) continue;
            std::wstring n = lowerW(name);
            if (n.find(L"blender") == std::wstring::npos) continue;
            anyBlender = &fam;
            if (n.find(L"bold") != std::wstring::npos)
                blenderBold = &fam;
            else
                blenderRegular = &fam;
        }
        if (!blenderRegular) blenderRegular = anyBlender;

        if (blenderRegular) {
            f.regular = {blenderRegular, FontStyleRegular};
            if (blenderBold)
                f.bold = {blenderBold, FontStyleRegular};  // dedicated bold family
            else
                f.bold = {blenderRegular,
                          blenderRegular->IsStyleAvailable(FontStyleBold) ? FontStyleBold
                                                                          : FontStyleRegular};
            return;
        }

        // Embedded fonts unavailable — fall back to a system font (matches the
        // ELO renderer's Bahnschrift/Arial choice).
        f.systemFallback = std::make_unique<FontFamily>(L"Bahnschrift");
        if (!f.systemFallback->IsAvailable())
            f.systemFallback = std::make_unique<FontFamily>(L"Arial");
        f.regular = {f.systemFallback.get(), FontStyleRegular};
        f.bold = {f.systemFallback.get(), FontStyleBold};
    });
    return f;
}

}  // namespace

BlenderFace blenderFace(bool bold) {
    BlenderFonts& f = fonts();
    return bold ? f.bold : f.regular;
}

Gdiplus::Bitmap* csrEmblem(const std::string& key) {
    static std::unordered_map<std::string, std::unique_ptr<Bitmap>> cache;
    static std::mutex mtx;
    std::lock_guard<std::mutex> lock(mtx);

    auto it = cache.find(key);
    if (it != cache.end()) return it->second.get();

    const CsrEmblemAsset* asset = nullptr;
    for (const auto& a : CSR_EMBLEM_ASSETS)
        if (key == a.key) {
            asset = &a;
            break;
        }
    if (!asset) {
        cache[key] = nullptr;
        return nullptr;
    }

    HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, asset->size);
    if (!hg) return nullptr;
    memcpy(GlobalLock(hg), asset->data, asset->size);
    GlobalUnlock(hg);
    IStream* stream = nullptr;
    if (FAILED(CreateStreamOnHGlobal(hg, TRUE, &stream))) {
        GlobalFree(hg);
        return nullptr;
    }
    auto bmp = std::make_unique<Bitmap>(stream);
    stream->Release();
    if (bmp->GetLastStatus() != Ok) {
        cache[key] = nullptr;
        return nullptr;
    }
    Bitmap* raw = bmp.get();
    cache[key] = std::move(bmp);
    return raw;
}

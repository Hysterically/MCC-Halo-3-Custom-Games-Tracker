#include "render_leaderboard.h"

#include <windows.h>
#include <objidl.h>

// The project builds with NOMINMAX; GDI+ headers expect min/max to exist.
#include <algorithm>
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

#include "aliases.h"
#include "category.h"
#include "medal_assets.h"
#include "util.h"

#pragma comment(lib, "gdiplus.lib")

namespace {

using namespace Gdiplus;

// --- palette / layout (mirrors src/renderLeaderboard.ts) ---------------------

constexpr int W = 1500;
constexpr int MARGIN = 16;
constexpr float TITLE_BASELINE = 60.0f;
constexpr int ROW_H = 46;
constexpr int ROW_GAP = 3;
constexpr int BOTTOM_PAD = 26;

// All rows share the neutral steel used for FFA rows on the carnage screen;
// the rank cell is the darker neutral used for the ELO cell there.
const Color ROW_COLOR(0x39, 0x43, 0x4f);
const Color RANK_CELL_COLOR(0x27, 0x2e, 0x37);

// Stat columns: header left-aligned at `x`, value right-aligned at `right` —
// the carnage screen's unrated layout shifted left so the table is inset by
// the medal gutter on both sides.
struct Col {
    const wchar_t* label;
    float x;
    float right;
};
const Col COLS[4] = {
    {L"ELO", 644, 824},
    {L"W-L-D", 849, 1026},
    {L"WIN%", 1051, 1228},
    {L"K/D", 1253, 1428},
};

constexpr int SECTION_TITLE_H = 56;  // gap above + section title baseline
constexpr int HEADER_GAP = 34;       // section title baseline -> header baseline
constexpr int HEADER_TO_ROWS = 12;   // header baseline -> first row top
constexpr int EMPTY_H = 36;          // "no matches yet" line
constexpr int GUTTER_W = 56;  // background strip left of the rows where the medals live
constexpr int RANK_W = 64;    // rank-number cell at the start of each row
constexpr int MEDAL_SIZE = 32;

// --- small helpers (same shapes as render_carnage.cpp) -----------------------

std::wstring widen(const std::string& utf8) {
    if (utf8.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, w.data(), n);
    return w;
}

void ensureGdiplus() {
    static std::once_flag once;
    static Status startStatus = Ok;
    std::call_once(once, [] {
        GdiplusStartupInput in;
        ULONG_PTR token = 0;  // intentionally never shut down (process lifetime)
        startStatus = GdiplusStartup(&token, &in, nullptr);
    });
    if (startStatus != Ok) throw std::runtime_error("GdiplusStartup failed");
}

CLSID pngEncoderClsid() {
    UINT count = 0, bytes = 0;
    if (GetImageEncodersSize(&count, &bytes) != Ok || !bytes)
        throw std::runtime_error("no GDI+ image encoders");
    std::vector<unsigned char> buf(bytes);
    auto* infos = reinterpret_cast<ImageCodecInfo*>(buf.data());
    if (GetImageEncoders(count, bytes, infos) != Ok)
        throw std::runtime_error("GetImageEncoders failed");
    for (UINT i = 0; i < count; ++i)
        if (wcscmp(infos[i].MimeType, L"image/png") == 0) return infos[i].Clsid;
    throw std::runtime_error("PNG encoder not found");
}

// A font whose em size is in pixels, plus the baseline offset DrawString needs.
struct PxFont {
    std::unique_ptr<Font> font;
    float ascent;
    PxFont(const FontFamily& ff, float px, INT style) {
        font = std::make_unique<Font>(&ff, px, style, UnitPixel);
        ascent = px * ff.GetCellAscent(style) / ff.GetEmHeight(style);
    }
};

void drawText(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush, float x,
              float baseline, const StringFormat* fmt) {
    g.DrawString(s.c_str(), -1, f.font.get(), PointF(x, baseline - f.ascent), fmt, &brush);
}

void drawTextRight(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush,
                   float right, float baseline, const StringFormat* fmt) {
    RectF box;
    g.MeasureString(s.c_str(), -1, f.font.get(), PointF(0, 0), fmt, &box);
    drawText(g, s, f, brush, right - box.Width, baseline, fmt);
}

// Decode one embedded medal PNG (see genMedalAssets.ts) into a GDI+ bitmap.
std::unique_ptr<Bitmap> loadMedal(const MedalAsset& asset) {
    HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, asset.size);
    if (!hg) throw std::runtime_error("GlobalAlloc failed");
    memcpy(GlobalLock(hg), asset.data, asset.size);
    GlobalUnlock(hg);
    IStream* stream = nullptr;
    if (FAILED(CreateStreamOnHGlobal(hg, TRUE, &stream))) {
        GlobalFree(hg);
        throw std::runtime_error("CreateStreamOnHGlobal failed");
    }
    auto bmp = std::make_unique<Bitmap>(stream);
    stream->Release();
    if (bmp->GetLastStatus() != Ok) throw std::runtime_error("medal PNG decode failed");
    return bmp;
}

int sectionHeight(const BoardSection& s, size_t limit) {
    size_t rows = std::min(s.ratings.size(), limit);
    int body = rows ? HEADER_GAP + HEADER_TO_ROWS + static_cast<int>(rows) * (ROW_H + ROW_GAP) -
                          ROW_GAP
                    : EMPTY_H;
    return SECTION_TITLE_H + body;
}

std::string upperAscii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

}  // namespace

std::vector<BoardSection> buildBoardSections(const std::vector<StoredMatch>& matches,
                                             EloOptions elo) {
    std::map<int, std::vector<StoredMatch>> byCat;  // key = Category as int
    for (const auto& m : matches) byCat[static_cast<int>(categorize(m))].push_back(m);

    std::vector<BoardSection> sections;
    for (Category c : BOARD_CATEGORIES) {
        auto it = byCat.find(static_cast<int>(c));
        std::vector<StoredMatch> ms = it != byCat.end() ? it->second : std::vector<StoredMatch>{};
        sections.push_back(
            {upperAscii(categoryLabel(c)) + " LEADERBOARD", computeRatings(ms, elo)});
    }
    return sections;
}

std::vector<std::uint8_t> renderLeaderboardPng(const std::vector<BoardSection>& sections,
                                               size_t limit) {
    ensureGdiplus();

    int height = static_cast<int>(TITLE_BASELINE) + 10 + BOTTOM_PAD;
    for (const auto& s : sections) height += sectionHeight(s, limit);

    Bitmap bmp(W, height, PixelFormat32bppARGB);
    Graphics g(&bmp);
    g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    g.SetSmoothingMode(SmoothingModeHighQuality);
    g.SetInterpolationMode(InterpolationModeHighQualityBicubic);  // medal downscale

    // GenericTypographic = no extra padding, so x/right line up exactly.
    const StringFormat* fmt = StringFormat::GenericTypographic();

    // Background: near-black with a faint cool vertical gradient.
    {
        LinearGradientBrush bg(PointF(0, 0), PointF(0, static_cast<float>(height)),
                               Color(0x14, 0x17, 0x1c), Color(0x0a, 0x0c, 0x10));
        g.FillRectangle(&bg, 0, 0, W, height);
    }

    auto family = std::make_unique<FontFamily>(L"Bahnschrift");
    if (!family->IsAvailable()) family = std::make_unique<FontFamily>(L"Arial");
    if (!family->IsAvailable()) throw std::runtime_error("no usable font family");

    PxFont titleFont(*family, 44, FontStyleBold);
    PxFont subtitleFont(*family, 28, FontStyleRegular);
    PxFont sectionFont(*family, 30, FontStyleBold);
    PxFont headerFont(*family, 20, FontStyleRegular);
    PxFont rowFont(*family, 22, FontStyleRegular);

    SolidBrush white(Color(0xff, 0xff, 0xff));
    SolidBrush subtitleBrush(Color(0xd4, 0xdb, 0xe4));
    SolidBrush headerBrush(Color(0x76, 0xb5, 0xd8));
    SolidBrush emptyBrush(Color(0x8b, 0x95, 0xa1));
    SolidBrush rowBrush(ROW_COLOR);
    SolidBrush rankBrush(RANK_CELL_COLOR);
    SolidBrush divider(Color(140, 0, 0, 0));  // rgba(0,0,0,0.55)

    std::unique_ptr<Bitmap> medals[3] = {loadMedal(MEDAL_ASSETS[0]), loadMedal(MEDAL_ASSETS[1]),
                                         loadMedal(MEDAL_ASSETS[2])};

    // Headline, same pattern as "<X> TEAM WON" + gametype subtitle.
    std::wstring title = L"ELO STANDINGS";
    drawText(g, title, titleFont, white, MARGIN, TITLE_BASELINE, fmt);
    RectF titleBox;
    g.MeasureString(title.c_str(), -1, titleFont.font.get(), PointF(0, 0), fmt, &titleBox);
    drawText(g, L"HALO 3 CUSTOMS", subtitleFont, subtitleBrush, MARGIN + titleBox.Width + 26,
             TITLE_BASELINE, fmt);

    int top = static_cast<int>(TITLE_BASELINE) + 10;
    for (const auto& s : sections) {
        float titleBaseline = static_cast<float>(top + SECTION_TITLE_H);
        drawText(g, widen(s.title), sectionFont, white, MARGIN, titleBaseline, fmt);

        if (s.ratings.empty()) {
            drawText(g, L"NO MATCHES YET", rowFont, emptyBrush, MARGIN + 2,
                     titleBaseline + EMPTY_H, fmt);
            top += sectionHeight(s, limit);
            continue;
        }

        float headerBaseline = titleBaseline + HEADER_GAP;
        drawText(g, L"#", headerFont, headerBrush, MARGIN + GUTTER_W + 18, headerBaseline, fmt);
        drawText(g, L"PLAYERS", headerFont, headerBrush, MARGIN + GUTTER_W + RANK_W + 16,
                 headerBaseline, fmt);
        for (const Col& c : COLS) drawText(g, c.label, headerFont, headerBrush, c.x,
                                           headerBaseline, fmt);

        float rowsTop = headerBaseline + HEADER_TO_ROWS;
        size_t n = std::min(s.ratings.size(), limit);
        for (size_t i = 0; i < n; ++i) {
            const Rating& r = s.ratings[i];
            float y = rowsTop + static_cast<float>(i) * (ROW_H + ROW_GAP);
            float rowX = static_cast<float>(MARGIN + GUTTER_W);

            g.FillRectangle(&rowBrush, rowX, y,
                            static_cast<float>(W - MARGIN - GUTTER_W) - rowX,
                            static_cast<float>(ROW_H));
            // Rank cell stays neutral, like the ELO cell on the carnage screen.
            g.FillRectangle(&rankBrush, rowX, y, static_cast<float>(RANK_W),
                            static_cast<float>(ROW_H));

            // Dark separators: after the rank cell and between stat columns.
            g.FillRectangle(&divider, rowX + RANK_W, y, 2.0f, static_cast<float>(ROW_H));
            for (const Col& c : COLS)
                g.FillRectangle(&divider, c.x - 14, y, 2.0f, static_cast<float>(ROW_H));

            float mid = y + ROW_H / 2.0f + 8.0f;  // baseline that centres 22px text

            // Podium medals float on the background gutter, outside the row.
            if (i < 3) {
                g.DrawImage(medals[i].get(),
                            RectF(MARGIN + (GUTTER_W - MEDAL_SIZE) / 2.0f,
                                  y + (ROW_H - MEDAL_SIZE) / 2.0f, MEDAL_SIZE, MEDAL_SIZE));
            }

            drawTextRight(g, std::to_wstring(i + 1), rowFont, white, rowX + RANK_W - 18, mid,
                          fmt);
            drawText(g, widen(displayName(r.gamertag)), rowFont, white, rowX + RANK_W + 16, mid,
                     fmt);

            std::string winPct =
                r.games ? std::to_string(util::jsRound(static_cast<double>(r.wins) /
                                                       static_cast<double>(r.games) * 100.0)) +
                              "%"
                        : "\xE2\x80\x94";  // —
            std::string kd = r.deaths
                                 ? util::toFixed2(static_cast<double>(r.kills) /
                                                  static_cast<double>(r.deaths))
                                 : util::toFixed2(static_cast<double>(r.kills));
            const std::wstring values[4] = {
                std::to_wstring(util::jsRound(r.rating)),
                widen(std::to_string(r.wins) + "-" + std::to_string(r.losses) + "-" +
                      std::to_string(r.draws)),
                widen(winPct),
                widen(kd),
            };
            for (int c = 0; c < 4; ++c)
                drawTextRight(g, values[c], rowFont, white, COLS[c].right - 6, mid, fmt);
        }

        top += sectionHeight(s, limit);
    }

    // Encode to PNG via an in-memory stream.
    IStream* stream = nullptr;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)))
        throw std::runtime_error("CreateStreamOnHGlobal failed");
    CLSID png = pngEncoderClsid();
    Status saved = bmp.Save(stream, &png, nullptr);
    if (saved != Ok) {
        stream->Release();
        throw std::runtime_error("PNG encode failed");
    }

    HGLOBAL hg = nullptr;
    GetHGlobalFromStream(stream, &hg);
    SIZE_T size = GlobalSize(hg);
    void* data = GlobalLock(hg);
    std::vector<std::uint8_t> out(static_cast<const std::uint8_t*>(data),
                                  static_cast<const std::uint8_t*>(data) + size);
    GlobalUnlock(hg);
    stream->Release();
    return out;
}

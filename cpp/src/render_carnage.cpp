#include "render_carnage.h"

#include <windows.h>
#include <objidl.h>

// The project builds with NOMINMAX; GDI+ headers expect min/max to exist.
#include <algorithm>
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include <climits>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

#include "aliases.h"

#pragma comment(lib, "gdiplus.lib")

namespace {

using namespace Gdiplus;

// --- palette / layout (mirrors src/renderCarnage.ts) ------------------------

// Row fill per Halo 3 team id (same order as TEAM_NAMES).
const Color TEAM_ROW_COLORS[8] = {
    Color(0x9e, 0x21, 0x1b),  // red
    Color(0x1d, 0x4a, 0x99),  // blue
    Color(0x2b, 0x6e, 0x31),  // green
    Color(0xb8, 0x6a, 0x14),  // orange
    Color(0x5d, 0x35, 0x90),  // purple
    Color(0xa8, 0x86, 0x1c),  // gold
    Color(0x5c, 0x46, 0x32),  // brown
    Color(0xb2, 0x5e, 0x7e),  // pink
};
const Color FFA_ROW_COLOR(0x39, 0x43, 0x4f);  // neutral steel

const wchar_t* TEAM_NAMES_W[8] = {L"RED",    L"BLUE", L"GREEN", L"ORANGE",
                                  L"PURPLE", L"GOLD", L"BROWN", L"PINK"};

constexpr int W = 1500;
constexpr int MARGIN = 16;
constexpr float TITLE_BASELINE = 60.0f;
constexpr float HEADER_BASELINE = 106.0f;
constexpr int ROWS_TOP = 118;
constexpr int ROW_H = 46;
constexpr int ROW_GAP = 3;
constexpr int BOTTOM_PAD = 22;

// Each stat column: header left-aligned at `x`, value right-aligned at `right`.
struct Col {
    const wchar_t* label;
    float x;
    float right;
};
const Col COLS[4] = {
    {L"SCORE", 700, 880},
    {L"KILLS", 905, 1082},
    {L"ASSISTS", 1107, 1284},
    {L"DEATHS", 1309, 1484},
};

// --- small helpers -----------------------------------------------------------

std::wstring widen(const std::string& utf8) {
    if (utf8.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, w.data(), n);
    return w;
}

std::wstring upper(std::wstring s) {
    if (!s.empty()) CharUpperBuffW(s.data(), static_cast<DWORD>(s.size()));
    return s;
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

// Sort: winning team first, then teams by total score; players by score
// within a team. FFA: by standing then score. Mirrors orderedPlayers in TS.
std::vector<CarnagePlayer> orderedPlayers(const CarnageReport& r) {
    std::vector<CarnagePlayer> out = r.players;
    if (!r.teamsEnabled) {
        std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
            if (a.standing != b.standing) return a.standing < b.standing;
            return a.score > b.score;
        });
        return out;
    }
    std::map<int, long long> totals;
    for (const auto& p : out) totals[p.teamId] += p.score;
    int winning = r.winningTeamId.value_or(INT_MIN);
    std::stable_sort(out.begin(), out.end(), [&](const auto& a, const auto& b) {
        if (a.teamId != b.teamId) {
            if (a.teamId == winning) return true;
            if (b.teamId == winning) return false;
            if (totals[a.teamId] != totals[b.teamId]) return totals[a.teamId] > totals[b.teamId];
            return a.teamId < b.teamId;
        }
        if (a.score != b.score) return a.score > b.score;
        return a.standing < b.standing;
    });
    return out;
}

std::wstring headline(const CarnageReport& r) {
    if (r.teamsEnabled) {
        if (!r.winningTeamId) return L"GAME OVER";
        int id = *r.winningTeamId;
        std::wstring team = (id >= 0 && id < 8) ? TEAM_NAMES_W[id]
                                                : L"TEAM " + std::to_wstring(id);
        return team + L" TEAM WON";
    }
    if (r.winners.empty()) return L"GAME OVER";
    return upper(widen(displayName(r.winners[0]))) + L" WON";
}

// A font whose em size is in pixels, plus the baseline offset DrawString needs
// (DrawString positions the cell top; baseline = top + cell ascent).
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

}  // namespace

std::vector<std::uint8_t> renderCarnagePng(const CarnageReport& r) {
    ensureGdiplus();

    std::vector<CarnagePlayer> players = orderedPlayers(r);
    int n = static_cast<int>(players.size());
    int height = ROWS_TOP + n * (ROW_H + ROW_GAP) - ROW_GAP + BOTTOM_PAD;

    Bitmap bmp(W, height, PixelFormat32bppARGB);
    Graphics g(&bmp);
    g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    g.SetSmoothingMode(SmoothingModeHighQuality);

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
    PxFont headerFont(*family, 20, FontStyleRegular);
    PxFont rowFont(*family, 22, FontStyleRegular);

    SolidBrush white(Color(0xff, 0xff, 0xff));
    SolidBrush subtitleBrush(Color(0xd4, 0xdb, 0xe4));
    SolidBrush headerBrush(Color(0x76, 0xb5, 0xd8));
    SolidBrush divider(Color(140, 0, 0, 0));  // rgba(0,0,0,0.55)

    // Headline + gametype (and map, when known).
    std::wstring title = headline(r);
    drawText(g, title, titleFont, white, MARGIN, TITLE_BASELINE, fmt);
    RectF titleBox;
    g.MeasureString(title.c_str(), -1, titleFont.font.get(), PointF(0, 0), fmt, &titleBox);
    std::wstring subtitle = widen(r.gameTypeName.empty() ? "Custom Game" : r.gameTypeName);
    if (!r.mapName.empty()) subtitle += L" ON " + widen(r.mapName);
    drawText(g, upper(subtitle), subtitleFont, subtitleBrush, MARGIN + titleBox.Width + 26,
             TITLE_BASELINE, fmt);

    // Column headers.
    drawText(g, L"PLAYERS", headerFont, headerBrush, MARGIN + 2, HEADER_BASELINE, fmt);
    for (const Col& c : COLS) drawText(g, c.label, headerFont, headerBrush, c.x, HEADER_BASELINE, fmt);

    // Rows.
    for (int i = 0; i < n; ++i) {
        const CarnagePlayer& p = players[i];
        float y = static_cast<float>(ROWS_TOP + i * (ROW_H + ROW_GAP));

        Color rowCol = FFA_ROW_COLOR;
        if (r.teamsEnabled && p.teamId >= 0 && p.teamId < 8) rowCol = TEAM_ROW_COLORS[p.teamId];
        SolidBrush rowBrush(rowCol);
        g.FillRectangle(&rowBrush, static_cast<REAL>(MARGIN), y, static_cast<REAL>(W - 2 * MARGIN),
                        static_cast<REAL>(ROW_H));

        // Vertical separators between stat columns.
        for (const Col& c : COLS)
            g.FillRectangle(&divider, c.x - 14, y, 2.0f, static_cast<REAL>(ROW_H));

        float mid = y + ROW_H / 2.0f + 8.0f;  // baseline that centres 22px text
        drawText(g, widen(displayName(p.gamertag)), rowFont, white, MARGIN + 16, mid, fmt);

        const long long values[4] = {p.score, p.kills, p.assists, p.deaths};
        for (int c = 0; c < 4; ++c)
            drawTextRight(g, std::to_wstring(values[c]), rowFont, white, COLS[c].right - 6, mid, fmt);
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

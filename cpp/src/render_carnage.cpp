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
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

#include "aliases.h"
#include "csr.h"
#include "csr_gfx.h"
#include "util.h"

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

// Each stat column: header left-aligned at `x`, value right-aligned at
// `right`; `stat` indexes {score, kills, assists, deaths} (-1 = ELO).
// Rated matches use the wider layout with an ELO column right of Deaths;
// its cell stays neutral instead of team-coloured.
struct Col {
    const wchar_t* label;
    float x;
    float right;
    int stat;
};
const Col COLS[4] = {
    {L"SCORE", 700, 880, 0},
    {L"KILLS", 905, 1082, 1},
    {L"ASSISTS", 1107, 1284, 2},
    {L"DEATHS", 1309, 1484, 3},
};
const Col COLS_ELO[5] = {
    {L"SCORE", 500, 680, 0},
    {L"KILLS", 705, 882, 1},
    {L"ASSISTS", 907, 1084, 2},
    {L"DEATHS", 1109, 1284, 3},
    {L"ELO", 1309, 1484, -1},
};
// Same geometry as COLS_ELO; the CSR content fits the same neutral cell.
const Col COLS_CSR[5] = {
    {L"SCORE", 500, 680, 0},
    {L"KILLS", 705, 882, 1},
    {L"ASSISTS", 907, 1084, 2},
    {L"DEATHS", 1109, 1284, 3},
    {L"CSR", 1309, 1484, -1},
};
const Color ELO_CELL_COLOR(0x27, 0x2e, 0x37);  // neutral, regardless of team colour

// Centre x of the (last) rating column, from its left divider to the frame edge.
float ratingCenter(const Col& c) {
    return (c.x - 14 + static_cast<float>(W - MARGIN)) / 2.0f;
}

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
    // Blender Pro face (the CSR carnage variant); style baked into the face.
    PxFont(BlenderFace face, float px) {
        const FontFamily* ff = face.family;
        font = std::make_unique<Font>(ff, px, face.style, UnitPixel);
        ascent = px * ff->GetCellAscent(face.style) / ff->GetEmHeight(face.style);
    }
};

void drawText(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush, float x,
              float baseline, const StringFormat* fmt) {
    g.DrawString(s.c_str(), -1, f.font.get(), PointF(x, baseline - f.ascent), fmt, &brush);
}

float measureW(Graphics& g, const std::wstring& s, const PxFont& f, const StringFormat* fmt) {
    RectF box;
    g.MeasureString(s.c_str(), -1, f.font.get(), PointF(0, 0), fmt, &box);
    return box.Width;
}

void drawTextRight(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush,
                   float right, float baseline, const StringFormat* fmt) {
    RectF box;
    g.MeasureString(s.c_str(), -1, f.font.get(), PointF(0, 0), fmt, &box);
    drawText(g, s, f, brush, right - box.Width, baseline, fmt);
}

void drawTextCenter(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush,
                    float cx, float baseline, const StringFormat* fmt) {
    drawText(g, s, f, brush, cx - measureW(g, s, f, fmt) / 2.0f, baseline, fmt);
}

// --- win-probability bar (mirrors drawWinBar in src/renderCarnage.ts) --------

// Title-case team names (the bar reads "Blue Team Average CSR: …", unlike the
// all-caps headline). Same order as TEAM_ROW_COLORS.
const wchar_t* TEAM_NAMES_TC[8] = {L"Red",    L"Blue", L"Green", L"Orange",
                                   L"Purple", L"Gold", L"Brown", L"Pink"};

Color lighten(const Color& c, double amt = 0.35) {
    auto f = [&](BYTE v) { return static_cast<BYTE>(std::lround(v + (255 - v) * amt)); };
    return Color(f(c.GetR()), f(c.GetG()), f(c.GetB()));
}

// Rounded-rect path with a per-corner radius (0 = square corner). GraphicsPath
// auto-connects consecutive segments with straight lines, so a zero-length line
// just registers a square corner point.
void addRoundRect(GraphicsPath& p, float x, float y, float w, float h, float tl, float tr, float br,
                  float bl) {
    p.StartFigure();
    if (tl > 0) p.AddArc(x, y, 2 * tl, 2 * tl, 180, 90);
    else p.AddLine(x, y, x, y);
    if (tr > 0) p.AddArc(x + w - 2 * tr, y, 2 * tr, 2 * tr, 270, 90);
    else p.AddLine(x + w, y, x + w, y);
    if (br > 0) p.AddArc(x + w - 2 * br, y + h - 2 * br, 2 * br, 2 * br, 0, 90);
    else p.AddLine(x + w, y + h, x + w, y + h);
    if (bl > 0) p.AddArc(x, y + h - 2 * bl, 2 * bl, 2 * bl, 90, 90);
    else p.AddLine(x, y + h, x, y + h);
    p.CloseFigure();
}

void drawWinBar(Graphics& g, const MatchWinChances& win, const StringFormat* fmt) {
    const TeamWinChance& A = win.teams[0];
    const TeamWinChance& B = win.teams[1];

    constexpr float BAR_W = 290, BAR_H = 14, BAR_TOP = 44, CAP_W = 16;
    const float barRight = W - MARGIN;
    const float barLeft = barRight - BAR_W;
    const float split = barLeft + std::round(BAR_W * static_cast<float>(A.winProb));
    const float r = BAR_H / 2.0f;
    auto teamColor = [](int id) {
        return (id >= 0 && id < 8) ? TEAM_ROW_COLORS[id] : FFA_ROW_COLOR;
    };
    auto teamName = [](int id) {
        return std::wstring((id >= 0 && id < 8) ? TEAM_NAMES_TC[id] : L"Team");
    };
    const Color colA = teamColor(A.teamId);
    const Color colB = teamColor(B.teamId);
    const std::wstring nameA = teamName(A.teamId);
    const std::wstring nameB = teamName(B.teamId);

    PxFont labelFont(blenderFace(false), 11);
    PxFont capFont(blenderFace(true), 10);
    SolidBrush white(Color(0xff, 0xff, 0xff));

    // Average-CSR line above each team's segment.
    drawText(g, nameA + L" Team Average CSR: " + std::to_wstring(A.avgCsr), labelFont, white,
             barLeft, BAR_TOP - 6, fmt);
    drawTextRight(g, nameB + L" Team Average CSR: " + std::to_wstring(B.avgCsr), labelFont, white,
                  barRight, BAR_TOP - 6, fmt);

    // Two segments meeting flush at the split: outer ends rounded, inner square.
    {
        GraphicsPath path;
        addRoundRect(path, barLeft, BAR_TOP, split - barLeft, BAR_H, r, 0, 0, r);
        SolidBrush brush(colA);
        g.FillPath(&brush, &path);
    }
    {
        GraphicsPath path;
        addRoundRect(path, split, BAR_TOP, barRight - split, BAR_H, 0, r, r, 0);
        SolidBrush brush(colB);
        g.FillPath(&brush, &path);
    }
    {
        SolidBrush seam(Color(102, 0, 0, 0));  // rgba(0,0,0,0.4)
        g.FillRectangle(&seam, split - 1, BAR_TOP, 2.0f, BAR_H);
    }

    // Brighter end caps with the team initial.
    auto cap = [&](float x, const Color& color, const std::wstring& letter) {
        GraphicsPath path;
        addRoundRect(path, x, BAR_TOP - 1, CAP_W, BAR_H + 2, 5, 5, 5, 5);
        SolidBrush brush(color);
        g.FillPath(&brush, &path);
        drawTextCenter(g, letter, capFont, white, x + CAP_W / 2.0f, BAR_TOP + BAR_H / 2.0f + 4, fmt);
    };
    cap(barLeft, lighten(colA), nameA.substr(0, 1));
    cap(barRight - CAP_W, lighten(colB), nameB.substr(0, 1));

    // Label row beneath: "<Blue> 58%   Chances of Winning   42% <Red>".
    const float labelY = BAR_TOP + BAR_H + 14;
    SolidBrush blueTint(Color(0xff, 0xff, 0xff));
    SolidBrush redTint(Color(0xff, 0xff, 0xff));
    SolidBrush grayTint(Color(0xff, 0xff, 0xff));
    int pctA = static_cast<int>(std::lround(A.winProb * 100));
    int pctB = static_cast<int>(std::lround(B.winProb * 100));
    drawText(g, nameA + L" " + std::to_wstring(pctA) + L"%", labelFont, blueTint, barLeft, labelY,
             fmt);
    drawTextRight(g, std::to_wstring(pctB) + L"% " + nameB, labelFont, redTint, barRight, labelY,
                  fmt);
    drawTextCenter(g, L"Chances of Winning", labelFont, grayTint, (barLeft + barRight) / 2.0f,
                   labelY, fmt);
}

}  // namespace

std::vector<std::uint8_t> renderCarnagePng(const CarnageReport& r,
                                           const std::map<std::string, EloChange>* eloChanges) {
    ensureGdiplus();

    std::vector<CarnagePlayer> players = orderedPlayers(r);
    int n = static_cast<int>(players.size());

    // Use the ELO-column layout when any player has a rating change.
    bool hasElo = false;
    if (eloChanges) {
        for (const auto& p : players) {
            if (eloChanges->count(p.xuid)) {
                hasElo = true;
                break;
            }
        }
    }
    const Col* cols = hasElo ? COLS_ELO : COLS;
    const int nCols = hasElo ? 5 : 4;

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
    for (int c = 0; c < nCols; ++c)
        drawText(g, cols[c].label, headerFont, headerBrush, cols[c].x, HEADER_BASELINE, fmt);

    // Rows.
    SolidBrush eloCell(ELO_CELL_COLOR);
    SolidBrush up(Color(0x7e, 0xd8, 0x7e));
    SolidBrush down(Color(0xe8, 0x83, 0x7f));
    SolidBrush flat(Color(0xc8, 0xcf, 0xd8));
    for (int i = 0; i < n; ++i) {
        const CarnagePlayer& p = players[i];
        float y = static_cast<float>(ROWS_TOP + i * (ROW_H + ROW_GAP));

        Color rowCol = FFA_ROW_COLOR;
        if (r.teamsEnabled && p.teamId >= 0 && p.teamId < 8) rowCol = TEAM_ROW_COLORS[p.teamId];
        SolidBrush rowBrush(rowCol);
        g.FillRectangle(&rowBrush, static_cast<REAL>(MARGIN), y, static_cast<REAL>(W - 2 * MARGIN),
                        static_cast<REAL>(ROW_H));

        // The ELO cell stays neutral: a rating change is not a team stat.
        for (int c = 0; c < nCols; ++c) {
            if (cols[c].stat >= 0) continue;
            float left = cols[c].x - 14;
            float right = c + 1 < nCols ? cols[c + 1].x - 14 : static_cast<float>(W - MARGIN);
            g.FillRectangle(&eloCell, left, y, right - left, static_cast<REAL>(ROW_H));
        }

        // Vertical separators between stat columns.
        for (int c = 0; c < nCols; ++c)
            g.FillRectangle(&divider, cols[c].x - 14, y, 2.0f, static_cast<REAL>(ROW_H));

        float mid = y + ROW_H / 2.0f + 8.0f;  // baseline that centres 22px text
        drawText(g, widen(displayName(p.gamertag)), rowFont, white, MARGIN + 16, mid, fmt);

        const long long values[4] = {p.score, p.kills, p.assists, p.deaths};
        for (int c = 0; c < nCols; ++c) {
            if (cols[c].stat >= 0) {
                drawTextRight(g, std::to_wstring(values[cols[c].stat]), rowFont, white,
                              cols[c].right - 6, mid, fmt);
                continue;
            }
            // Post-match rating + change, e.g. "1318 +16" (green gain / red
            // loss); blank for unrated players.
            auto it = eloChanges->find(p.xuid);
            if (it == eloChanges->end()) continue;
            long d = util::jsRound(it->second.delta);
            std::wstring ds = widen((d >= 0 ? "+" : "") + std::to_string(d));
            const SolidBrush& brush = d > 0 ? up : d < 0 ? down : flat;
            drawTextRight(g, ds, rowFont, brush, cols[c].right - 6, mid, fmt);
            RectF dsBox;
            g.MeasureString(ds.c_str(), -1, rowFont.font.get(), PointF(0, 0), fmt, &dsBox);
            drawTextRight(g, std::to_wstring(util::jsRound(it->second.rating)), rowFont, white,
                          cols[c].right - 6 - dsBox.Width - 9, mid, fmt);
        }
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

std::vector<std::uint8_t> renderCarnageCsrPng(const CarnageReport& r,
                                              const std::map<std::string, CsrChange>* csrChanges,
                                              const MatchWinChances* win) {
    ensureGdiplus();

    std::vector<CarnagePlayer> players = orderedPlayers(r);
    int n = static_cast<int>(players.size());

    bool hasCsr = false;
    if (csrChanges) {
        for (const auto& p : players) {
            if (csrChanges->count(p.xuid)) {
                hasCsr = true;
                break;
            }
        }
    }
    const Col* cols = hasCsr ? COLS_CSR : COLS;
    const int nCols = hasCsr ? 5 : 4;

    int height = ROWS_TOP + n * (ROW_H + ROW_GAP) - ROW_GAP + BOTTOM_PAD;

    Bitmap bmp(W, height, PixelFormat32bppARGB);
    Graphics g(&bmp);
    g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    g.SetSmoothingMode(SmoothingModeHighQuality);
    g.SetInterpolationMode(InterpolationModeHighQualityBicubic);  // emblem downscale

    const StringFormat* fmt = StringFormat::GenericTypographic();

    {
        LinearGradientBrush bg(PointF(0, 0), PointF(0, static_cast<float>(height)),
                               Color(0x14, 0x17, 0x1c), Color(0x0a, 0x0c, 0x10));
        g.FillRectangle(&bg, 0, 0, W, height);
    }

    PxFont titleFont(blenderFace(true), 44);
    PxFont subtitleFont(blenderFace(false), 28);
    PxFont headerFont(blenderFace(false), 20);
    PxFont rowFont(blenderFace(false), 22);

    SolidBrush white(Color(0xff, 0xff, 0xff));
    SolidBrush subtitleBrush(Color(0xd4, 0xdb, 0xe4));
    SolidBrush headerBrush(Color(0x76, 0xb5, 0xd8));
    SolidBrush divider(Color(140, 0, 0, 0));

    // Headline + gametype (and map, when known).
    std::wstring title = headline(r);
    drawText(g, title, titleFont, white, MARGIN, TITLE_BASELINE, fmt);
    float titleW = measureW(g, title, titleFont, fmt);
    std::wstring subtitle = widen(r.gameTypeName.empty() ? "Custom Game" : r.gameTypeName);
    if (!r.mapName.empty()) subtitle += L" ON " + widen(r.mapName);
    drawText(g, upper(subtitle), subtitleFont, subtitleBrush, MARGIN + titleW + 26, TITLE_BASELINE,
             fmt);

    // Win-probability bar (top-right) — only for rated 2-team matches.
    if (win) drawWinBar(g, *win, fmt);

    // Column headers — all left-aligned at their column's x (CSR included).
    drawText(g, L"PLAYERS", headerFont, headerBrush, MARGIN + 2, HEADER_BASELINE, fmt);
    for (int c = 0; c < nCols; ++c)
        drawText(g, cols[c].label, headerFont, headerBrush, cols[c].x, HEADER_BASELINE, fmt);

    SolidBrush ratingCell(ELO_CELL_COLOR);
    SolidBrush up(Color(0x7e, 0xd8, 0x7e));
    SolidBrush down(Color(0xe8, 0x83, 0x7f));
    SolidBrush flat(Color(0xc8, 0xcf, 0xd8));
    const float CSR_EMBLEM_H = 34.0f;
    const float gapE = 10.0f;  // emblem -> number
    const float gapD = 14.0f;  // number -> change

    for (int i = 0; i < n; ++i) {
        const CarnagePlayer& p = players[i];
        float y = static_cast<float>(ROWS_TOP + i * (ROW_H + ROW_GAP));

        Color rowCol = FFA_ROW_COLOR;
        if (r.teamsEnabled && p.teamId >= 0 && p.teamId < 8) rowCol = TEAM_ROW_COLORS[p.teamId];
        SolidBrush rowBrush(rowCol);
        g.FillRectangle(&rowBrush, static_cast<REAL>(MARGIN), y, static_cast<REAL>(W - 2 * MARGIN),
                        static_cast<REAL>(ROW_H));

        // The CSR cell stays neutral: a rating change is not a team stat.
        for (int c = 0; c < nCols; ++c) {
            if (cols[c].stat >= 0) continue;
            float left = cols[c].x - 14;
            float right = c + 1 < nCols ? cols[c + 1].x - 14 : static_cast<float>(W - MARGIN);
            g.FillRectangle(&ratingCell, left, y, right - left, static_cast<REAL>(ROW_H));
        }

        for (int c = 0; c < nCols; ++c)
            g.FillRectangle(&divider, cols[c].x - 14, y, 2.0f, static_cast<REAL>(ROW_H));

        float mid = y + ROW_H / 2.0f + 8.0f;
        drawText(g, widen(displayName(p.gamertag)), rowFont, white, MARGIN + 16, mid, fmt);

        const long long values[4] = {p.score, p.kills, p.assists, p.deaths};
        for (int c = 0; c < nCols; ++c) {
            if (cols[c].stat >= 0) {
                drawTextRight(g, std::to_wstring(values[cols[c].stat]), rowFont, white,
                              cols[c].right - 6, mid, fmt);
                continue;
            }
            // CSR cell — blank for unrated players (guests).
            auto it = csrChanges->find(p.xuid);
            if (it == csrChanges->end()) continue;
            const CsrChange& ch = it->second;
            int d = ch.delta;
            std::wstring deltaText = widen((d >= 0 ? "+" : "") + std::to_string(d));
            std::wstring mainText = widen(std::to_string(ch.csr.value));
            float mainW = measureW(g, mainText, rowFont, fmt);
            float deltaW = measureW(g, deltaText, rowFont, fmt);
            // A Champion (top 3 on the board who has cleared the floor — flagged by
            // matchCsrChanges) wears the Champion insignia instead of their tier emblem.
            const std::string emblemKey =
                ch.champion ? "champion" : ch.csr.emblem;
            Bitmap* img = csrEmblem(emblemKey);
            float ew = (img && img->GetHeight()) ? static_cast<float>(img->GetWidth()) /
                                                       static_cast<float>(img->GetHeight()) *
                                                       CSR_EMBLEM_H
                                                 : 0.0f;
            float groupW = ew + (img ? gapE : 0) + mainW + gapD + deltaW;
            float x = ratingCenter(cols[c]) - groupW / 2.0f;
            if (img) {
                g.DrawImage(img, RectF(x, y + (ROW_H - CSR_EMBLEM_H) / 2.0f, ew, CSR_EMBLEM_H));
                x += ew + gapE;
            }
            drawText(g, mainText, rowFont, white, x, mid, fmt);
            x += mainW + gapD;
            const SolidBrush& brush = d > 0 ? up : d < 0 ? down : flat;
            drawText(g, deltaText, rowFont, brush, x, mid, fmt);
        }
    }

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

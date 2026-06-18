#include "render_csr_leaderboard.h"

#include <windows.h>
#include <objidl.h>

#include <algorithm>
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include <cmath>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

#include "aliases.h"
#include "csr.h"
#include "csr_gfx.h"
#include "medal_assets.h"
#include "trueskill2.h"
#include "util.h"

#pragma comment(lib, "gdiplus.lib")

namespace {

using namespace Gdiplus;

// --- palette / layout (mirrors src/renderCsrLeaderboard.ts) ------------------
constexpr int W = 1500;
constexpr int MARGIN = 16;
constexpr float TITLE_BASELINE = 60.0f;
constexpr int ROW_H = 46;
constexpr int ROW_GAP = 3;
constexpr int BOTTOM_PAD = 26;

const Color ROW_COLOR(0x39, 0x43, 0x4f);
const Color RANK_CELL_COLOR(0x27, 0x2e, 0x37);

constexpr int SECTION_TITLE_H = 56;
constexpr int HEADER_GAP = 34;
constexpr int HEADER_TO_ROWS = 12;
constexpr int EMPTY_H = 36;
constexpr int GUTTER_W = 56;
constexpr int RANK_W = 64;
constexpr int MEDAL_SIZE = 32;
constexpr float CSR_EMBLEM_H = 34.0f;
constexpr int NAME_W = 340;
constexpr float CSR_PAD = 20.0f;
constexpr float GROUP_GAP = 10.0f;
constexpr float SUBTITLE_GAP = 32.0f;

const wchar_t* STAT_LABELS[4] = {L"W-L-D", L"WIN%", L"K/D", L"PEAK CSR"};

// --- small helpers -----------------------------------------------------------
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

struct PxFont {
    std::unique_ptr<Font> font;
    float ascent;
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

float measure(Graphics& g, const std::wstring& s, const PxFont& f, const StringFormat* fmt) {
    RectF box;
    g.MeasureString(s.c_str(), -1, f.font.get(), PointF(0, 0), fmt, &box);
    return box.Width;
}

void drawTextRight(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush,
                   float right, float baseline, const StringFormat* fmt) {
    drawText(g, s, f, brush, right - measure(g, s, f, fmt), baseline, fmt);
}

void drawTextCenter(Graphics& g, const std::wstring& s, const PxFont& f, const Brush& brush,
                    float center, float baseline, const StringFormat* fmt) {
    drawText(g, s, f, brush, center - measure(g, s, f, fmt) / 2.0f, baseline, fmt);
}

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

// --- CSR row helpers (mirror renderCsrLeaderboard.ts) ------------------------
bool isChampion(int rankIndex, double skill) {
    return rankIndex == 0 && csrFromSkill(skill).value >= CHAMPION_THRESHOLD;
}
std::string rankLabel(double skill, int rankIndex) {
    if (isChampion(rankIndex, skill)) return "champion";
    Csr c = csrFromSkill(skill);
    return c.isOnyx ? "onyx" : util::toLower(c.tier) + " " + std::to_string(c.sub);
}
std::string rowEmblemKey(double skill, int rankIndex) {
    return isChampion(rankIndex, skill) ? "champion" : csrFromSkill(skill).emblem;
}

float emblemWidth(Bitmap* img) {
    if (!img || img->GetHeight() == 0) return 0;
    return static_cast<float>(img->GetWidth()) / static_cast<float>(img->GetHeight()) * CSR_EMBLEM_H;
}

struct StatCol {
    float left, right, headerX, valueX;
};
struct Layout {
    float rankX, nameLeft, csrLeft, csrRight, csrCenter;
    StatCol stats[4];
};

Layout computeLayout(Graphics& g, const std::vector<CsrBoardSection>& sections, size_t limit,
                     const PxFont& rowFont, const StringFormat* fmt) {
    float maxGroup = 0;
    for (const auto& s : sections) {
        size_t n = std::min(s.rows.size(), limit);
        for (size_t i = 0; i < n; ++i) {
            const CsrRow& r = s.rows[i];
            Csr c = csrFromSkill(r.skill);
            Bitmap* img = csrEmblem(rowEmblemKey(r.skill, static_cast<int>(i)));
            float ew = emblemWidth(img);
            float w = measure(g, widen(rankLabel(r.skill, static_cast<int>(i))), rowFont, fmt) +
                      GROUP_GAP + ew + GROUP_GAP +
                      measure(g, widen("(" + std::to_string(c.value) + ")"), rowFont, fmt);
            maxGroup = std::max(maxGroup, w);
        }
    }

    Layout L;
    L.rankX = MARGIN + GUTTER_W;
    L.nameLeft = L.rankX + RANK_W;
    L.csrLeft = L.nameLeft + NAME_W;
    L.csrRight = L.csrLeft + maxGroup + CSR_PAD * 2;
    L.csrCenter = (L.csrLeft + L.csrRight) / 2.0f;
    float statsLeft = L.csrRight;
    float statW = (W - MARGIN - statsLeft) / 4.0f;
    for (int i = 0; i < 4; ++i) {
        float left = statsLeft + i * statW;
        float right = left + statW;
        L.stats[i] = {left, right, left + 14, right - 8};
    }
    return L;
}

int sectionHeight(const CsrBoardSection& s, size_t limit) {
    size_t rows = std::min(s.rows.size(), limit);
    int body = rows ? HEADER_GAP + HEADER_TO_ROWS + static_cast<int>(rows) * (ROW_H + ROW_GAP) -
                          ROW_GAP
                    : EMPTY_H;
    return SECTION_TITLE_H + body;
}

}  // namespace

CsrBoardSection buildCsrBoardSection(const std::vector<StoredMatch>& matches, Category cat) {
    std::vector<StoredMatch> ms;
    for (const auto& m : matches)
        if (boardCategory(m) == cat) ms.push_back(m);

    std::vector<MMR> ratings = rateCategory(ms);
    std::vector<const MMR*> ranked;
    for (const auto& r : ratings)
        if (r.games > 0) ranked.push_back(&r);
    std::stable_sort(ranked.begin(), ranked.end(),
                     [](const MMR* a, const MMR* b) { return a->skill > b->skill; });

    CsrBoardSection section;
    section.title = std::string(categoryLabel(cat)) + " LEADERBOARD";
    // categoryLabel already upper-cases FFA; 2v2/4v4 stay as-is, matching the TS
    // title CATEGORY_LABEL[c].toUpperCase() (2v2/4v4 have no letters to upper).
    for (const MMR* r : ranked) {
        CsrRow row;
        row.gamertag = r->gamertag;
        row.skill = r->skill;
        row.peakSkill = r->peakSkill;
        row.wins = r->wins;
        row.losses = r->losses;
        row.draws = r->draws;
        row.games = r->games;
        row.kills = r->kills;
        row.deaths = r->deaths;
        section.rows.push_back(std::move(row));
    }
    return section;
}

std::vector<CsrBoardSection> buildCsrBoardSections(const std::vector<StoredMatch>& matches) {
    std::vector<CsrBoardSection> out;
    for (Category c : BOARD_CATEGORIES) out.push_back(buildCsrBoardSection(matches, c));
    return out;
}

std::vector<std::uint8_t> renderCsrLeaderboardPng(const std::vector<CsrBoardSection>& sections,
                                                  size_t limit) {
    ensureGdiplus();

    float sectionsTop = TITLE_BASELINE + SUBTITLE_GAP + 14;
    int height = static_cast<int>(sectionsTop) + BOTTOM_PAD;
    for (const auto& s : sections) height += sectionHeight(s, limit);

    Bitmap bmp(W, height, PixelFormat32bppARGB);
    Graphics g(&bmp);
    g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    g.SetSmoothingMode(SmoothingModeHighQuality);
    g.SetInterpolationMode(InterpolationModeHighQualityBicubic);

    const StringFormat* fmt = StringFormat::GenericTypographic();

    {
        LinearGradientBrush bg(PointF(0, 0), PointF(0, static_cast<float>(height)),
                               Color(0x14, 0x17, 0x1c), Color(0x0a, 0x0c, 0x10));
        g.FillRectangle(&bg, 0, 0, W, height);
    }

    PxFont titleFont(blenderFace(true), 44);
    PxFont subtitleFont(blenderFace(false), 28);
    PxFont sectionFont(blenderFace(true), 30);
    PxFont headerFont(blenderFace(false), 20);
    PxFont rowFont(blenderFace(false), 22);

    SolidBrush white(Color(0xff, 0xff, 0xff));
    SolidBrush subtitleBrush(Color(0xd4, 0xdb, 0xe4));
    SolidBrush headerBrush(Color(0x76, 0xb5, 0xd8));
    SolidBrush emptyBrush(Color(0x8b, 0x95, 0xa1));
    SolidBrush rowBrush(ROW_COLOR);
    SolidBrush rankBrush(RANK_CELL_COLOR);
    SolidBrush divider(Color(140, 0, 0, 0));
    SolidBrush csrLabelBrush(Color(0xcf, 0xe3, 0xf2));

    std::unique_ptr<Bitmap> medals[3] = {loadMedal(MEDAL_ASSETS[0]), loadMedal(MEDAL_ASSETS[1]),
                                         loadMedal(MEDAL_ASSETS[2])};

    Layout L = computeLayout(g, sections, limit, rowFont, fmt);

    // Centred two-line headline.
    drawTextCenter(g, L"CSR STANDINGS", titleFont, white, W / 2.0f, TITLE_BASELINE, fmt);
    drawTextCenter(g, L"HALO 3 CUSTOMS", subtitleFont, subtitleBrush, W / 2.0f,
                   TITLE_BASELINE + SUBTITLE_GAP, fmt);

    float top = sectionsTop;
    for (const auto& s : sections) {
        float titleBaseline = top + SECTION_TITLE_H;
        drawText(g, widen(s.title), sectionFont, white, MARGIN, titleBaseline, fmt);

        if (s.rows.empty()) {
            drawText(g, L"NO MATCHES YET", rowFont, emptyBrush, MARGIN + 2, titleBaseline + EMPTY_H,
                     fmt);
            top += sectionHeight(s, limit);
            continue;
        }

        float headerBaseline = titleBaseline + HEADER_GAP;
        drawText(g, L"#", headerFont, headerBrush, MARGIN + GUTTER_W + 18, headerBaseline, fmt);
        drawText(g, L"PLAYERS", headerFont, headerBrush, L.nameLeft + 16, headerBaseline, fmt);
        drawText(g, L"CSR", headerFont, headerBrush, L.csrLeft + 14, headerBaseline, fmt);
        for (int c = 0; c < 4; ++c)
            drawText(g, STAT_LABELS[c], headerFont, headerBrush, L.stats[c].headerX, headerBaseline,
                     fmt);

        float rowsTop = headerBaseline + HEADER_TO_ROWS;
        size_t n = std::min(s.rows.size(), limit);
        for (size_t i = 0; i < n; ++i) {
            const CsrRow& r = s.rows[i];
            float y = rowsTop + static_cast<float>(i) * (ROW_H + ROW_GAP);
            float rowX = L.rankX;

            g.FillRectangle(&rowBrush, rowX, y, static_cast<float>(W - MARGIN) - rowX,
                            static_cast<float>(ROW_H));
            g.FillRectangle(&rankBrush, rowX, y, static_cast<float>(RANK_W),
                            static_cast<float>(ROW_H));

            // Dark separators: rank cell, CSR column, each stat column.
            g.FillRectangle(&divider, rowX + RANK_W, y, 2.0f, static_cast<float>(ROW_H));
            g.FillRectangle(&divider, L.csrLeft, y, 2.0f, static_cast<float>(ROW_H));
            for (int c = 0; c < 4; ++c)
                g.FillRectangle(&divider, L.stats[c].left, y, 2.0f, static_cast<float>(ROW_H));

            float mid = y + ROW_H / 2.0f + 8.0f;

            if (i < 3)
                g.DrawImage(medals[i].get(),
                            RectF(MARGIN + (GUTTER_W - MEDAL_SIZE) / 2.0f,
                                  y + (ROW_H - MEDAL_SIZE) / 2.0f, MEDAL_SIZE, MEDAL_SIZE));

            drawTextRight(g, std::to_wstring(i + 1), rowFont, white, rowX + RANK_W - 18, mid, fmt);
            drawText(g, widen(displayName(r.gamertag)), rowFont, white, L.nameLeft + 16, mid, fmt);

            // CSR cell: emblem + rank label + (value), centred as one group.
            Csr cell = csrFromSkill(r.skill);
            std::wstring labelText = widen(rankLabel(r.skill, static_cast<int>(i)));
            std::wstring valueText = widen("(" + std::to_string(cell.value) + ")");
            float labelW = measure(g, labelText, rowFont, fmt);
            float valueW = measure(g, valueText, rowFont, fmt);
            Bitmap* img = csrEmblem(rowEmblemKey(r.skill, static_cast<int>(i)));
            float ew = emblemWidth(img);
            float gx = L.csrCenter - (ew + GROUP_GAP + labelW + GROUP_GAP + valueW) / 2.0f;
            if (img) {
                g.DrawImage(img, RectF(gx, y + (ROW_H - CSR_EMBLEM_H) / 2.0f, ew, CSR_EMBLEM_H));
                gx += ew + GROUP_GAP;
            }
            drawText(g, labelText, rowFont, csrLabelBrush, gx, mid, fmt);
            gx += labelW + GROUP_GAP;
            drawText(g, valueText, rowFont, white, gx, mid, fmt);

            // Stat columns (right-aligned values).
            std::string winPct =
                r.games ? std::to_string(util::jsRound(static_cast<double>(r.wins) /
                                                       static_cast<double>(r.games) * 100.0)) +
                              "%"
                        : "\xE2\x80\x94";
            std::string kd = r.deaths ? util::toFixed2(static_cast<double>(r.kills) /
                                                       static_cast<double>(r.deaths))
                                      : util::toFixed2(static_cast<double>(r.kills));
            std::string peak = std::to_string(csrFromSkill(r.peakSkill).value);
            const std::wstring values[4] = {
                widen(std::to_string(r.wins) + "-" + std::to_string(r.losses) + "-" +
                      std::to_string(r.draws)),
                widen(winPct),
                widen(kd),
                widen(peak),
            };
            for (int c = 0; c < 4; ++c)
                drawTextRight(g, values[c], rowFont, white, L.stats[c].valueX, mid, fmt);
        }

        top += sectionHeight(s, limit);
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

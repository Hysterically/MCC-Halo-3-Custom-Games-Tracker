// Native GUI window — Win32 + GDI+, owner-drawn flat dark theme (Dear ImGui look
// without Dear ImGui). See gui.h. Display-only first cut: opens the shared DB and
// paints a live leaderboard, refreshed on a timer. Live watching/posting still
// runs via `h3-tracker watch`; wiring the watcher into this window is the next step.

#include "gui.h"

#include <windows.h>
#include <objidl.h>

// The project builds with NOMINMAX; GDI+ headers expect min/max to exist.
#include <algorithm>
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include <cstdio>
#include <cwchar>
#include <memory>
#include <string>
#include <vector>

#include "aliases.h"
#include "category.h"
#include "config.h"
#include "csr.h"
#include "db.h"
#include "render_csr_leaderboard.h"

#pragma comment(lib, "gdiplus.lib")

using namespace Gdiplus;

namespace {

// --- theme (flat dark, ImGui-ish) ------------------------------------------
const Color BG(255, 0x16, 0x16, 0x1A);       // window background
const Color CARD(255, 0x1E, 0x1E, 0x26);      // panel/card
const Color CARD_HI(255, 0x26, 0x26, 0x30);   // alternating row / hover
const Color ACCENT(255, 0x42, 0x96, 0xFA);    // ImGui blue
const Color TEXT(255, 0xE6, 0xE6, 0xEA);      // primary text
const Color MUTED(255, 0x8A, 0x8A, 0x93);     // secondary text
const Color GOLD(255, 0xFE, 0xE7, 0x5C);
const Color SILVER(255, 0xC4, 0xC4, 0xCE);
const Color BRONZE(255, 0xCD, 0x7F, 0x32);
const Color LIVE(255, 0x57, 0xF2, 0x87);      // green status dot

constexpr int PAD = 16;
constexpr int HEADER_H = 64;
constexpr int TAB_H = 36;
constexpr int ROW_H = 34;
constexpr UINT_PTR REFRESH_TIMER = 1;

std::wstring wide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
    return w;
}

Color hexColor(const std::string& hex) {
    unsigned r = 0xE6, g = 0xE6, b = 0xEA;
    if (hex.size() >= 7 && hex[0] == '#') sscanf_s(hex.c_str() + 1, "%02x%02x%02x", &r, &g, &b);
    return Color(255, (BYTE)r, (BYTE)g, (BYTE)b);
}

void roundRect(GraphicsPath& p, const RectF& r, float rad) {
    float d = rad * 2;
    p.Reset();
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.GetRight() - d, r.Y, d, d, 270, 90);
    p.AddArc(r.GetRight() - d, r.GetBottom() - d, d, d, 0, 90);
    p.AddArc(r.X, r.GetBottom() - d, d, d, 90, 90);
    p.CloseFigure();
}

void fillRound(Graphics& g, const RectF& r, float rad, const Color& c) {
    GraphicsPath p;
    roundRect(p, r, rad);
    SolidBrush b(c);
    g.FillPath(&b, &p);
}

// Left/(optionally right)-aligned single line of text within a rect.
void text(Graphics& g, const std::wstring& s, const Font& f, const Color& c, const RectF& r,
          StringAlignment align = StringAlignmentNear) {
    StringFormat fmt;
    fmt.SetAlignment(align);
    fmt.SetLineAlignment(StringAlignmentCenter);
    fmt.SetTrimming(StringTrimmingEllipsisCharacter);
    fmt.SetFormatFlags(StringFormatFlagsNoWrap);
    SolidBrush b(c);
    g.DrawString(s.c_str(), -1, &f, r, &fmt, &b);
}

// --- window state ----------------------------------------------------------
struct GuiState {
    std::unique_ptr<Db> db;
    std::vector<StoredMatch> matches;
    long long total = 0;
    int tab = 0;  // index into BOARD_CATEGORIES
    RectF tabRects[3];
};

void refresh(GuiState& s) {
    try {
        s.matches = s.db->matchesChrono();
        s.total = (long long)s.matches.size();
    } catch (...) {
        // keep the last snapshot on a transient DB hiccup
    }
}

// --- painting --------------------------------------------------------------
void paint(HWND hwnd, GuiState& s) {
    RECT rc;
    GetClientRect(hwnd, &rc);
    int W = rc.right, H = rc.bottom;
    if (W <= 0 || H <= 0) return;

    PAINTSTRUCT ps;
    HDC hdc = BeginPaint(hwnd, &ps);

    // Double-buffer into a memory bitmap to avoid flicker.
    Bitmap buffer(W, H, PixelFormat32bppPARGB);
    Graphics g(&buffer);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);
    g.Clear(BG);

    FontFamily fam(L"Segoe UI");
    Font fTitle(&fam, 17, FontStyleBold, UnitPixel);
    Font fHead(&fam, 12, FontStyleBold, UnitPixel);
    Font fBody(&fam, 14, FontStyleRegular, UnitPixel);
    Font fBodyB(&fam, 14, FontStyleBold, UnitPixel);
    Font fSmall(&fam, 12, FontStyleRegular, UnitPixel);

    // Header card.
    RectF header((float)PAD, (float)PAD, (float)(W - 2 * PAD), (float)HEADER_H);
    fillRound(g, header, 10, CARD);
    text(g, L"Halo 3 Customs Tracker", fTitle, TEXT,
         RectF(header.X + 18, header.Y, header.Width - 220, header.Height));
    // Status: green dot + match count, right-aligned.
    SolidBrush dot(LIVE);
    g.FillEllipse(&dot, header.GetRight() - 192, header.Y + HEADER_H / 2.0f - 4, 8.0f, 8.0f);
    text(g, wide("live  \xC2\xB7  " + std::to_string(s.total) + " matches"), fSmall, MUTED,
         RectF(header.GetRight() - 176, header.Y, 160, header.Height));

    // Category tabs.
    float tabY = header.GetBottom() + 12;
    float tx = (float)PAD;
    for (int i = 0; i < 3; ++i) {
        std::wstring label = wide(categoryLabel(BOARD_CATEGORIES[i]));
        RectF tab(tx, tabY, 84, (float)TAB_H);
        s.tabRects[i] = tab;
        bool sel = i == s.tab;
        fillRound(g, tab, 8, sel ? ACCENT : CARD);
        text(g, label, fHead, sel ? Color(255, 0x10, 0x12, 0x16) : MUTED, tab,
             StringAlignmentCenter);
        tx += tab.Width + 8;
    }

    // Leaderboard card.
    float boardY = tabY + TAB_H + 12;
    RectF board((float)PAD, boardY, (float)(W - 2 * PAD), (float)(H - boardY - PAD));
    fillRound(g, board, 10, CARD);

    CsrBoardSection section = buildCsrBoardSection(s.matches, BOARD_CATEGORIES[s.tab]);

    // Column layout (x offsets within the board, from its left edge).
    float bx = board.X + 18, bw = board.Width - 36;
    float cRank = bx, cName = bx + 44, cCsr = bx + bw * 0.42f, cWld = bx + bw * 0.66f,
          cKd = bx + bw * 0.84f;
    float rowW = bw;

    // Column header.
    float y = board.Y + 14;
    text(g, L"#", fHead, MUTED, RectF(cRank, y, 40, 20));
    text(g, L"PLAYER", fHead, MUTED, RectF(cName, y, cCsr - cName - 8, 20));
    text(g, L"CSR", fHead, MUTED, RectF(cCsr, y, cWld - cCsr - 8, 20));
    text(g, L"W-L-D", fHead, MUTED, RectF(cWld, y, cKd - cWld - 8, 20));
    text(g, L"K/D", fHead, MUTED, RectF(cKd, y, bx + bw - cKd, 20));
    y += 26;

    if (section.rows.empty()) {
        text(g, L"No matches yet \xE2\x80\x94 play some customs!", fBody, MUTED,
             RectF(bx, y + 8, bw, 24));
    }

    int rank = 0;
    for (const auto& r : section.rows) {
        if (y + ROW_H > board.GetBottom() - 8) break;  // clip to card
        ++rank;
        if (rank % 2 == 0)
            fillRound(g, RectF(board.X + 8, y, board.Width - 16, (float)ROW_H), 6, CARD_HI);

        Color rankColor = rank == 1 ? GOLD : rank == 2 ? SILVER : rank == 3 ? BRONZE : MUTED;
        text(g, std::to_wstring(rank), fBodyB, rankColor, RectF(cRank, y, 40, (float)ROW_H));
        text(g, wide(displayName(r.gamertag)), fBody, TEXT,
             RectF(cName, y, cCsr - cName - 8, (float)ROW_H));

        Csr csr = csrFromSkill(r.skill);
        text(g, wide(csr.label + "  " + std::to_string(csr.value)), fBody, hexColor(csr.color),
             RectF(cCsr, y, cWld - cCsr - 8, (float)ROW_H));

        std::string wld = std::to_string(r.wins) + "-" + std::to_string(r.losses) + "-" +
                          std::to_string(r.draws);
        text(g, wide(wld), fBody, MUTED, RectF(cWld, y, cKd - cWld - 8, (float)ROW_H));

        double kd = r.deaths ? (double)r.kills / (double)r.deaths : (double)r.kills;
        wchar_t kdbuf[16];
        swprintf_s(kdbuf, L"%.2f", kd);
        text(g, kdbuf, fBody, TEXT, RectF(cKd, y, bx + bw - cKd, (float)ROW_H));

        y += ROW_H;
    }
    (void)rowW;

    // Blit.
    Graphics screen(hdc);
    screen.DrawImage(&buffer, 0, 0, W, H);
    EndPaint(hwnd, &ps);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    auto* s = reinterpret_cast<GuiState*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));
    switch (msg) {
        case WM_ERASEBKGND:
            return 1;  // we paint the whole client, no flicker
        case WM_TIMER:
            if (wp == REFRESH_TIMER && s) {
                refresh(*s);
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        case WM_LBUTTONDOWN:
            if (s) {
                float mx = (float)LOWORD(lp), my = (float)HIWORD(lp);
                for (int i = 0; i < 3; ++i) {
                    const RectF& t = s->tabRects[i];
                    if (mx >= t.X && mx <= t.GetRight() && my >= t.Y && my <= t.GetBottom()) {
                        s->tab = i;
                        InvalidateRect(hwnd, nullptr, FALSE);
                        break;
                    }
                }
            }
            return 0;
        case WM_PAINT:
            if (s) paint(hwnd, *s);
            return 0;
        case WM_DESTROY:
            KillTimer(hwnd, REFRESH_TIMER);
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

}  // namespace

int cmdGui() {
    GuiState state;
    state.db = openDb(config().dbUrl, config().dbAuthToken);
    refresh(state);

    ULONG_PTR gdiplusToken = 0;
    GdiplusStartupInput gdiplusInput;
    GdiplusStartup(&gdiplusToken, &gdiplusInput, nullptr);

    // Hide the console window this command was launched from for a clean look.
    if (HWND console = GetConsoleWindow()) ShowWindow(console, SW_HIDE);

    HINSTANCE inst = GetModuleHandle(nullptr);
    WNDCLASSEX wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = nullptr;  // we paint it
    wc.lpszClassName = L"H3TrackerGui";
    RegisterClassEx(&wc);

    HWND hwnd = CreateWindowEx(0, wc.lpszClassName, L"Halo 3 Customs Tracker",
                               WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 920, 640, nullptr,
                               nullptr, inst, nullptr);
    if (!hwnd) {
        GdiplusShutdown(gdiplusToken);
        return 1;
    }
    SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&state));
    SetTimer(hwnd, REFRESH_TIMER, 3000, nullptr);
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    MSG m;
    while (GetMessage(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }

    GdiplusShutdown(gdiplusToken);
    return (int)m.wParam;
}

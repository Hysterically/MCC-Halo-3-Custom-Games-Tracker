// Optional native GUI window (Win32 + GDI+, no extra dependencies). A flat dark
// dashboard themed after the Dear ImGui aesthetic — but plain Win32, so nothing
// an anti-cheat or a wary player would find suspicious. It only reads the shared
// DB (same as the console watcher); it never touches the game.
//
// First cut: a live-refreshing leaderboard view (header + category tabs + table).
// Run with `h3-tracker gui`.
#pragma once

int cmdGui();

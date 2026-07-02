cmake_minimum_required(VERSION 3.21)

# Static CRT so the final exe needs no VC++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "")

project(h3-tracker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(pugixml CONFIG REQUIRED)
find_package(unofficial-sqlite3 CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(CURL CONFIG REQUIRED)

# Phase 1 sources (network/watcher/gateway added in later phases).
set(H3_SOURCES
  src/main.cpp
  src/config.cpp
  src/carnage.cpp
  src/mapinfo.cpp
  src/elo.cpp
  src/csr.cpp
  src/trueskill2.cpp
  src/aliases.cpp
  src/format.cpp
  src/db.cpp
  src/db_sqlite.cpp
  src/db_hrana.cpp
  src/http.cpp
  src/render_carnage.cpp
  src/render_leaderboard.cpp
  src/render_csr_leaderboard.cpp
  src/csr_gfx.cpp
  src/discord_webhook.cpp
  src/discord_gateway.cpp
  src/heal.cpp
  src/update_check.cpp
  src/watcher.cpp
  src/status_bar.cpp
  src/setup.cpp
  src/cli.cpp
)

# Version resource + manifest: identify the exe to Windows (and to Defender/
# SmartScreen heuristics, which score unsigned metadata-less exes badly).
# Numeric version parsed from H3_VERSION ("v1.2.3"); a "dev" build is 0.0.0.
set(H3_VER_MAJOR 0)
set(H3_VER_MINOR 0)
set(H3_VER_PATCH 0)
set(H3_VER_DISPLAY "dev")
if(DEFINED H3_VERSION AND H3_VERSION MATCHES "^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)")
  set(H3_VER_MAJOR ${CMAKE_MATCH_1})
  set(H3_VER_MINOR ${CMAKE_MATCH_2})
  set(H3_VER_PATCH ${CMAKE_MATCH_3})
  set(H3_VER_DISPLAY "${H3_VERSION}")
endif()
configure_file(src/version.rc.in "${CMAKE_BINARY_DIR}/version.rc" @ONLY)
list(APPEND H3_SOURCES "${CMAKE_BINARY_DIR}/version.rc" src/h3-tracker.manifest)

add_executable(h3-tracker ${H3_SOURCES})
target_include_directories(h3-tracker PRIVATE src)
# Tells db.cpp / cli.cpp the real remote-DB and gateway backends are linked, so
# they drop their throw-stubs.
target_compile_definitions(h3-tracker PRIVATE H3_HAVE_HRANA=1 H3_HAVE_GATEWAY=1)
# The build's version string for the outdated-build check. Passed in by the
# release path (build.bat / bundle.bat set H3_VERSION from the git tag); a plain
# dev build leaves it "dev", which keeps the update check silent (see version.h).
if(DEFINED H3_VERSION AND NOT H3_VERSION STREQUAL "")
  target_compile_definitions(h3-tracker PRIVATE H3_VERSION_STR="${H3_VERSION}")
endif()
target_link_libraries(h3-tracker PRIVATE
  pugixml::pugixml
  unofficial::sqlite3::sqlite3
  nlohmann_json::nlohmann_json
  CURL::libcurl
  Shell32
  Ole32
  Ws2_32
  Gdiplus
)

if(MSVC)
  target_compile_options(h3-tracker PRIVATE /utf-8 /W3 /EHsc)
  # Windows API + UTF-8 console.
  target_compile_definitions(h3-tracker PRIVATE
    UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
    _CRT_SECURE_NO_WARNINGS)
endif()

set_target_properties(h3-tracker PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

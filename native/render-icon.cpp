// SPDX-License-Identifier: MIT
#include <vector>
#include <map>
#include <string>
#include <cstring>
#include <algorithm>
#include "icons.hpp"
int main(int argc, char **argv) {
    if (argc != 3) { g_printerr("Usage: koya-render-icon source.svg output.png\n"); return 2; }
    return Icons::rasterize(argv[1], argv[2]) ? 0 : 1;
}

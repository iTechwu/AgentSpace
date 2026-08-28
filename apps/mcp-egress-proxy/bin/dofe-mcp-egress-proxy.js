#!/usr/bin/env node
// 3.6-9：直接 import 入口 main，省去 spawnSync 子进程一层开销
// （Node ≥23.6 类型剥离默认开启，无需再传 --experimental-strip-types）。
import { main } from "../src/index.ts";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

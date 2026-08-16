#!/usr/bin/env node
// 3.6-9：直接 import 入口 main，省去 spawnSync 子进程一层开销
// （Node ≥23.6 类型剥离默认开启，无需再传 --experimental-strip-types；
// 入口的 isMain 守卫在 argv[1] 指向本 wrapper 时为 false，不会重复执行）。
import { main } from "../src/index.ts";

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });

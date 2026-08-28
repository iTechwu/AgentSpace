"use client";

import { useTransition, useState } from "react";
import { updateManagedRuntimeSharingAction } from "@/features/runtimes/actions";

export function ManagedRuntimeSharingToggle({
  runtimeId,
  allowNewEmployeeSharing,
}: {
  runtimeId: string;
  allowNewEmployeeSharing: boolean;
}) {
  const [value, setValue] = useState(allowNewEmployeeSharing);
  const [pending, startTransition] = useTransition();

  return (
    <label className="runtime-sharing-toggle">
      <span className="runtime-sharing-toggle__copy">
        <strong>{value ? "允许新员工使用" : "已暂停新员工使用"}</strong>
        <small>
          {value
            ? "新创建的 AI 员工可以分配到此执行引擎。"
            : "保留现有分配，但不能再添加新的 AI 员工。"}
        </small>
      </span>
      <span className="runtime-sharing-toggle__control">
        {pending ? <span className="runtime-sharing-toggle__saving">保存中</span> : null}
        <input
          type="checkbox"
          checked={value}
          disabled={pending}
          onChange={(event) => {
            const next = event.target.checked;
            setValue(next);
            startTransition(async () => {
              try {
                await updateManagedRuntimeSharingAction({
                  runtimeId,
                  allowNewEmployeeSharing: next,
                });
              } catch (error) {
                setValue(allowNewEmployeeSharing);
                throw error;
              }
            });
          }}
        />
        <span className="runtime-sharing-toggle__switch" aria-hidden="true" />
      </span>
    </label>
  );
}

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
    <label className="flex items-center gap-2 text-sm">
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
      <span>Allow new AI employees to share this runtime</span>
      {pending ? <span className="text-xs text-neutral-500">Saving…</span> : null}
    </label>
  );
}

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
        <strong>{value ? "Sharing is enabled" : "Sharing is paused"}</strong>
        <small>
          {value
            ? "New AI employees can be assigned to this runtime."
            : "Existing assignments are preserved; new employees cannot be added."}
        </small>
      </span>
      <span className="runtime-sharing-toggle__control">
        {pending ? <span className="runtime-sharing-toggle__saving">Saving</span> : null}
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

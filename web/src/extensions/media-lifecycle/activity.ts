import { useUserStore } from "@/stores/use-user-store";
import { recordActivity } from "./api";
import { lifecycleEpoch } from "./session";

export async function touchLifecycleEntity(kind: string, id: string, action: "open" | "play" | "download" | "edit") {
    const token = useUserStore.getState().token;
    if (!token || !kind || !id) return;
    const epoch = await lifecycleEpoch(token);
    if (useUserStore.getState().token !== token) return;
    await recordActivity({ kind, id, epoch, operationId: `${action}:${crypto.randomUUID()}` });
}

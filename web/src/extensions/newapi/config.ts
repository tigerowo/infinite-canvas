import { channelProtocolForConfig, type AiConfig } from "@/stores/use-config-store";

export function isNewAPIConfig(config: AiConfig) {
    return channelProtocolForConfig(config) === "newapi";
}

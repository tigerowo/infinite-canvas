import type { HomeBanner } from "@/app/(user)/home-banner-carousel";

const hiddenBannerPaths = ["/88.webp", "/metaso.webp"];

export function filterHomeBanners(banners: HomeBanner[]): HomeBanner[] {
    return banners.filter(({ imageUrl }) => !hiddenBannerPaths.some((path) => imageUrl.endsWith(path)));
}

export type JimengGenerationType = "image" | "video";

export type JimengModelProfile = {
    model: string;
    label: string;
    generationType: JimengGenerationType;
    resolutions: string[];
    defaultResolution: string;
    defaultDuration: number;
    durationRange?: [number, number];
};

export const JIMENG_IMAGE_MODEL = "jimeng-image-5.0";
export const JIMENG_VIDEO_MODEL = "jimeng-video-seedance2.0fast";

export const jimengModelProfiles: JimengModelProfile[] = [
    { model: "jimeng-image-3.0", label: "即梦图片 3.0", generationType: "image", resolutions: ["1k", "2k"], defaultResolution: "1k", defaultDuration: 0 },
    { model: "jimeng-image-3.1", label: "即梦图片 3.1", generationType: "image", resolutions: ["1k", "2k"], defaultResolution: "1k", defaultDuration: 0 },
    { model: "jimeng-image-4.0", label: "即梦图片 4.0", generationType: "image", resolutions: ["2k", "4k"], defaultResolution: "2k", defaultDuration: 0 },
    { model: "jimeng-image-4.1", label: "即梦图片 4.1", generationType: "image", resolutions: ["2k", "4k"], defaultResolution: "2k", defaultDuration: 0 },
    { model: "jimeng-image-4.5", label: "即梦图片 4.5", generationType: "image", resolutions: ["2k", "4k"], defaultResolution: "2k", defaultDuration: 0 },
    { model: "jimeng-image-4.6", label: "即梦图片 4.6", generationType: "image", resolutions: ["2k", "4k"], defaultResolution: "2k", defaultDuration: 0 },
    { model: "jimeng-image-4.7", label: "即梦图片 4.7", generationType: "image", resolutions: ["2k", "4k"], defaultResolution: "2k", defaultDuration: 0 },
    { model: JIMENG_IMAGE_MODEL, label: "即梦图片 5.0", generationType: "image", resolutions: ["2k", "4k"], defaultResolution: "2k", defaultDuration: 0 },
    { model: "jimeng-image-5.0Pro", label: "即梦图片 5.0 Pro", generationType: "image", resolutions: ["1.5k", "2k", "4k"], defaultResolution: "1.5k", defaultDuration: 0 },
    { model: "jimeng-video-seedance2.0", label: "Seedance 2.0", generationType: "video", resolutions: ["720p"], defaultResolution: "720p", defaultDuration: 4, durationRange: [4, 15] },
    { model: JIMENG_VIDEO_MODEL, label: "Seedance 2.0 Fast", generationType: "video", resolutions: ["720p"], defaultResolution: "720p", defaultDuration: 4, durationRange: [4, 15] },
    { model: "jimeng-video-seedance2.0_vip", label: "Seedance 2.0 VIP", generationType: "video", resolutions: ["720p", "1080p", "4k"], defaultResolution: "720p", defaultDuration: 4, durationRange: [4, 15] },
    { model: "jimeng-video-seedance2.0fast_vip", label: "Seedance 2.0 Fast VIP", generationType: "video", resolutions: ["720p"], defaultResolution: "720p", defaultDuration: 4, durationRange: [4, 15] },
    { model: "jimeng-video-seedance2.0mini", label: "Seedance 2.0 Mini", generationType: "video", resolutions: ["720p"], defaultResolution: "720p", defaultDuration: 4, durationRange: [4, 15] },
    { model: "jimeng-video-seedance2.5", label: "Seedance 2.5", generationType: "video", resolutions: ["480p", "720p", "1080p"], defaultResolution: "480p", defaultDuration: 4, durationRange: [4, 30] },
];

const profileByModel = new Map(jimengModelProfiles.map((profile) => [profile.model, profile]));

export function jimengModelProfile(model: string) {
    return profileByModel.get(model);
}

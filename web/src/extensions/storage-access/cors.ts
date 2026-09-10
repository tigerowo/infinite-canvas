export function corsRule(origins: string[]) {
    return {
        AllowedOrigins: [...new Set(origins.map((value) => value.trim()).filter(Boolean))],
        AllowedMethods: ["GET", "HEAD"],
        AllowedHeaders: ["Range", "If-None-Match", "If-Modified-Since"],
        ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
        MaxAgeSeconds: 600,
    };
}

export function corsXML(origins: string[]) {
    const rule = corsRule(origins);
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
    const fields = [
        ...rule.AllowedOrigins.map((value) => "    <AllowedOrigin>" + escape(value) + "</AllowedOrigin>"),
        ...rule.AllowedMethods.map((value) => "    <AllowedMethod>" + value + "</AllowedMethod>"),
        ...rule.AllowedHeaders.map((value) => "    <AllowedHeader>" + value + "</AllowedHeader>"),
        ...rule.ExposeHeaders.map((value) => "    <ExposeHeader>" + value + "</ExposeHeader>"),
        "    <MaxAgeSeconds>600</MaxAgeSeconds>",
    ];
    return ['<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">', "  <CORSRule>", ...fields, "  </CORSRule>", "</CORSConfiguration>"].join("\n");
}

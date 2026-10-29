import { fetch } from "expo/fetch";
import { File, UploadType } from "expo-file-system";

import type { HttpClient } from "@/core/http";

export const deviceHttp: HttpClient = {
  async send(method, url, options = {}) {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: options.signal,
    });
    return { status: response.status, body: await response.text() };
  },

  // File.upload streams the file natively as the raw body. (expo/fetch would
  // read a File body into JS memory first.)
  async upload(url, fileUri, options) {
    const result = await new File(fileUri).upload(url, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers: options.headers,
      signal: options.signal,
      // A background session could finish the upload after the app is gone;
      // the by-key check covers that, but foreground keeps the flow plain.
      sessionType: "foreground",
    });
    return { status: result.status, body: result.body };
  },
};

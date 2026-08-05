const DEFAULT_TIMEOUT_MS = 15_000;
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

class OneDriveGraphError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OneDriveGraphError";
    this.kind = options.kind || "UPSTREAM";
    this.status = options.status || null;
    this.code = options.code || null;
  }
}

function requireString(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized) {
    throw new OneDriveGraphError(`${fieldName} is required`, {
      kind: "CONFIGURATION",
      code: "INVALID_UPLOAD_ARGUMENT",
    });
  }

  return normalized;
}

function validatePathSegment(segment, fieldName) {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new OneDriveGraphError(`${fieldName} contains an invalid path segment`, {
      kind: "CONFIGURATION",
      code: "INVALID_UPLOAD_PATH",
    });
  }

  return segment;
}

function encodeFolderPath(folderPath) {
  const normalized = requireString(folderPath, "folderPath").replace(
    /^\/+|\/+$/g,
    "",
  );

  if (!normalized) {
    throw new OneDriveGraphError("folderPath is required", {
      kind: "CONFIGURATION",
      code: "INVALID_UPLOAD_PATH",
    });
  }

  return normalized
    .split("/")
    .map((segment) =>
      encodeURIComponent(validatePathSegment(segment, "folderPath")),
    )
    .join("/");
}

function encodeFilename(filename) {
  const normalized = requireString(filename, "filename");

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    !normalized.toLowerCase().endsWith(".json")
  ) {
    throw new OneDriveGraphError("filename must be a safe JSON filename", {
      kind: "CONFIGURATION",
      code: "INVALID_UPLOAD_FILENAME",
    });
  }

  return encodeURIComponent(normalized);
}

function buildUploadUrl({ graphBaseUrl = GRAPH_BASE_URL, driveId, folderPath, filename }) {
  const normalizedBaseUrl = requireString(graphBaseUrl, "graphBaseUrl").replace(
    /\/+$/,
    "",
  );

  const encodedDriveId = encodeURIComponent(requireString(driveId, "driveId"));
  const encodedFolderPath = encodeFolderPath(folderPath);
  const encodedFilename = encodeFilename(filename);

  return `${normalizedBaseUrl}/drives/${encodedDriveId}/root:/${encodedFolderPath}/${encodedFilename}:/content`;
}

function createRequestSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeoutId);

      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortFromExternalSignal);
      }
    },
  };
}

function getResponseError(response) {
  if (response.status === 401 || response.status === 403) {
    return new OneDriveGraphError("Microsoft Graph authentication failed", {
      kind: "AUTHENTICATION",
      status: response.status,
      code: "GRAPH_AUTHENTICATION_FAILED",
    });
  }

  if (response.status === 429) {
    return new OneDriveGraphError("Microsoft Graph request was throttled", {
      kind: "THROTTLED",
      status: response.status,
      code: "GRAPH_THROTTLED",
    });
  }

  if (response.status >= 400 && response.status < 500) {
    return new OneDriveGraphError("Microsoft Graph rejected the upload", {
      kind: "REQUEST",
      status: response.status,
      code: "GRAPH_UPLOAD_REJECTED",
    });
  }

  return new OneDriveGraphError("Microsoft Graph upload failed", {
    kind: "UPSTREAM",
    status: response.status,
    code: "GRAPH_UPLOAD_FAILED",
  });
}

function createOneDriveGraphClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const graphBaseUrl = options.graphBaseUrl || GRAPH_BASE_URL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }

  async function uploadJson({
    accessToken,
    driveId,
    folderPath,
    filename,
    content,
    signal,
  }) {
    const normalizedAccessToken = requireString(accessToken, "accessToken");
    const url = buildUploadUrl({
      graphBaseUrl,
      driveId,
      folderPath,
      filename,
    });

    let serializedContent;

    try {
      serializedContent = JSON.stringify(content);
    } catch {
      throw new OneDriveGraphError("content must be JSON serializable", {
        kind: "CONFIGURATION",
        code: "INVALID_JSON_CONTENT",
      });
    }

    if (serializedContent === undefined) {
      throw new OneDriveGraphError("content must be JSON serializable", {
        kind: "CONFIGURATION",
        code: "INVALID_JSON_CONTENT",
      });
    }

    const requestSignal = createRequestSignal(signal, timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${normalizedAccessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: serializedContent,
        signal: requestSignal.signal,
      });

      if (!response.ok) {
        throw getResponseError(response);
      }

      return {
        uploaded: true,
      };
    } catch (error) {
      if (error instanceof OneDriveGraphError) {
        throw error;
      }

      if (requestSignal.timedOut()) {
        throw new OneDriveGraphError("Microsoft Graph upload timed out", {
          kind: "TIMEOUT",
          code: "GRAPH_UPLOAD_TIMEOUT",
        });
      }

      if (signal?.aborted || requestSignal.signal.aborted) {
        throw new OneDriveGraphError("Microsoft Graph upload was aborted", {
          kind: "ABORTED",
          code: "GRAPH_UPLOAD_ABORTED",
        });
      }

      throw new OneDriveGraphError("Could not connect to Microsoft Graph", {
        kind: "NETWORK",
        code: "GRAPH_NETWORK_ERROR",
      });
    } finally {
      requestSignal.cleanup();
    }
  }

  return {
    uploadJson,
  };
}

module.exports = {
  OneDriveGraphError,
  buildUploadUrl,
  createOneDriveGraphClient,
};

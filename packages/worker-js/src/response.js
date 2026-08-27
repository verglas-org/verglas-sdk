/**
 * Cloudflare Workers permits a null-body Response with status 101 for a
 * WebSocket upgrade. StarlingMonkey's WHATWG implementation follows the
 * browser fetch range (200..599), so install the one Cloudflare extension the
 * Durable Object Hibernation API needs.
 */

const NativeResponse = globalThis.Response;

function supportsSwitchingProtocols() {
  try {
    return new NativeResponse(null, { status: 101 }).status === 101;
  } catch {
    return false;
  }
}

if (typeof NativeResponse === 'function' && !supportsSwitchingProtocols()) {
  class CloudflareResponse extends NativeResponse {
    static [Symbol.hasInstance](value) {
      return value instanceof NativeResponse;
    }

    constructor(body = null, init = {}) {
      if (Number(init?.status ?? 200) !== 101) {
        super(body, init);
        return;
      }
      if (body !== null && body !== undefined) {
        throw new TypeError('WebSocket upgrade Response must have a null body');
      }
      super(null, { ...init, status: 200 });
      Object.defineProperties(this, {
        status: { value: 101, enumerable: true },
        statusText: { value: init.statusText ?? '', enumerable: true },
        ok: { value: false, enumerable: true },
      });
    }
  }

  Object.defineProperty(globalThis, 'Response', {
    value: CloudflareResponse,
    configurable: true,
    writable: true,
  });
}

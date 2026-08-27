import { FormData } from "undici";
import { describe, it } from "vitest";
import { addVerglasComponentToWorkerUploadForm } from "../src/deploy/helpers/create-worker-upload-form";

describe("Verglas component upload extension", () => {
	it("adds the compiled component without replacing source metadata", async ({
		expect,
	}) => {
		const form = new FormData();
		form.set("metadata", JSON.stringify({ main_module: "index.js" }));
		addVerglasComponentToWorkerUploadForm(
			form,
			new Uint8Array([0, 97, 115, 109])
		);

		expect(JSON.parse(form.get("metadata") as string)).toMatchObject({
			main_module: "index.js",
			verglas_component_part: "__verglas_component",
		});
		const component = form.get("__verglas_component");
		expect(component).toBeInstanceOf(File);
		expect((component as File).type).toBe("application/wasm");
		expect(await (component as File).arrayBuffer()).toEqual(
			new Uint8Array([0, 97, 115, 109]).buffer
		);
	});
});

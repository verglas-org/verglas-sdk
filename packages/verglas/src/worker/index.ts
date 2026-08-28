import { createNamespace } from "../core/create-command";

export const workerNamespace = createNamespace({
	metadata: {
		description: "Build and manage custom Verglas Workers",
		status: "stable",
		owner: "Workers: Authoring and Testing",
	},
});

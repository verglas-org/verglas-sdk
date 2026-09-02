import { createNamespace } from "../core/create-command";

export const notebooksNamespace = createNamespace({
	metadata: {
		description: "Deploy and trigger Jupyter notebooks as Python Workers",
		status: "experimental",
		owner: "Workers: Authoring and Testing",
		category: "Compute & AI",
	},
});

import ModuleDetail from "./module-detail";

export default async function ModuleDetailPage({
	params,
}: {
	params: Promise<{ moduleName: string }>;
}) {
	const { moduleName } = await params;
	return <ModuleDetail moduleName={decodeURIComponent(moduleName)} />;
}

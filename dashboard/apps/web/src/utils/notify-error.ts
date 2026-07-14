import { toast } from "sonner";

const MAX_DETAIL_LENGTH = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value : undefined;

const numberValue = (value: unknown): string | undefined =>
	typeof value === "number" ? String(value) : undefined;

const compactLines = (lines: Array<string | undefined>): string =>
	lines.filter(Boolean).join("\n");

const truncate = (value: string): string =>
	value.length > MAX_DETAIL_LENGTH
		? `${value.slice(0, MAX_DETAIL_LENGTH)}\n...`
		: value;

const jsonPreview = (value: unknown): string | undefined => {
	try {
		return truncate(JSON.stringify(value, null, 2));
	} catch {
		return;
	}
};

const nestedError = (value: unknown): Record<string, unknown> | undefined => {
	if (!isRecord(value)) {
		return;
	}
	const error = value.error;
	return isRecord(error) ? error : undefined;
};

export const errorMessage = (error: unknown): string => {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	if (isRecord(error)) {
		return (
			stringValue(error.message) ??
			stringValue(nestedError(error)?.message) ??
			"Unexpected error"
		);
	}
	return stringValue(error) ?? "Unexpected error";
};

export const errorDetails = (error: unknown): string => {
	const lines: Array<string | undefined> = [];
	if (isRecord(error)) {
		const data = isRecord(error.data) ? error.data : undefined;
		const nested = nestedError(error);
		const nestedData = isRecord(nested?.data) ? nested.data : undefined;
		lines.push(
			numberValue(error.status) ?? numberValue(data?.httpStatus),
			stringValue(error.url),
			stringValue(error.name),
			stringValue(error.code) ??
				stringValue(data?.code) ??
				stringValue(nested?.code),
			stringValue(error.path) ??
				stringValue(data?.path) ??
				stringValue(nestedData?.path),
			stringValue(error.body),
			stringValue(data?.stack) ?? stringValue(nestedData?.stack)
		);
		if (error.cause) {
			lines.push(`cause: ${errorMessage(error.cause)}`);
		}
	}
	if (error instanceof Error && error.stack) {
		lines.push(error.stack);
	}
	const detail = compactLines(lines);
	return truncate(detail || jsonPreview(error) || errorMessage(error));
};

export const notifyError = (
	error: unknown,
	options: {
		action?: { label: string; onClick: () => void };
		title?: string;
	} = {}
) => {
	toast.error(options.title ?? errorMessage(error), {
		action: options.action,
		description: errorDetails(error),
		duration: 12_000,
	});
};

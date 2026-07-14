"use client";

import { useEffect } from "react";

import { notifyError } from "@/utils/notify-error";

export function ErrorEvents() {
	useEffect(() => {
		const onError = (event: ErrorEvent) => {
			notifyError(event.error ?? event.message, {
				title: event.message || "Runtime error",
			});
		};
		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			notifyError(event.reason, {
				title: "Unhandled promise rejection",
			});
		};

		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onUnhandledRejection);
		return () => {
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onUnhandledRejection);
		};
	}, []);

	return null;
}

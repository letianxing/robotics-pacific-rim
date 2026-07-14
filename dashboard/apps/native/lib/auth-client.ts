import { expoClient } from "@better-auth/expo/client";
import { env } from "@dashboard/env/native";
import { createAuthClient } from "better-auth/react";
import Constants from "expo-constants";
import { getItem, setItem } from "expo-secure-store";

const secureStore = {
	getItem,
	setItem,
};

export const authClient = createAuthClient({
	baseURL: env.EXPO_PUBLIC_SERVER_URL,
	plugins: [
		expoClient({
			scheme: Constants.expoConfig?.scheme as string,
			storagePrefix: Constants.expoConfig?.scheme as string,
			storage: secureStore,
		}),
	],
});

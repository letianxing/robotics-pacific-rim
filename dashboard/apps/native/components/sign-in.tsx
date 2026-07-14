import { useForm } from "@tanstack/react-form";
import {
	Button,
	FieldError,
	Input,
	Label,
	Spinner,
	Surface,
	TextField,
	useToast,
} from "heroui-native";
import { useRef } from "react";
import { Text, type TextInput, View } from "react-native";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/utils/trpc";

const signInSchema = z.object({
	email: z
		.string()
		.trim()
		.min(1, "Email is required")
		.email("Enter a valid email address"),
	password: z
		.string()
		.min(1, "Password is required")
		.min(8, "Use at least 8 characters"),
});

function getErrorMessage(error: unknown): string | null {
	if (!error) {
		return null;
	}

	if (typeof error === "string") {
		return error;
	}

	if (Array.isArray(error)) {
		for (const issue of error) {
			const message = getErrorMessage(issue);
			if (message) {
				return message;
			}
		}
		return null;
	}

	if (typeof error === "object" && error !== null) {
		const maybeError = error as { message?: unknown };
		if (typeof maybeError.message === "string") {
			return maybeError.message;
		}
	}

	return null;
}

function SignIn() {
	const passwordInputRef = useRef<TextInput>(null);
	const { toast } = useToast();

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
		},
		validators: {
			onSubmit: signInSchema,
		},
		onSubmit: async ({ value, formApi }) => {
			await authClient.signIn.email(
				{
					email: value.email.trim(),
					password: value.password,
				},
				{
					onError(error) {
						toast.show({
							variant: "danger",
							label: error.error?.message || "Failed to sign in",
						});
					},
					onSuccess() {
						formApi.reset();
						toast.show({
							variant: "success",
							label: "Signed in successfully",
						});
						queryClient.refetchQueries();
					},
				}
			);
		},
	});

	return (
		<Surface className="rounded-lg p-4" variant="secondary">
			<Text className="mb-4 font-medium text-foreground">Sign In</Text>

			<form.Subscribe
				selector={(state) => ({
					isSubmitting: state.isSubmitting,
					validationError: getErrorMessage(state.errorMap.onSubmit),
				})}
			>
				{({ isSubmitting, validationError }) => {
					const formError = validationError;

					return (
						<>
							<FieldError className="mb-3" isInvalid={!!formError}>
								{formError}
							</FieldError>

							<View className="gap-3">
								<form.Field name="email">
									{(field) => (
										<TextField>
											<Label>Email</Label>
											<Input
												autoCapitalize="none"
												autoComplete="email"
												blurOnSubmit={false}
												keyboardType="email-address"
												onBlur={field.handleBlur}
												onChangeText={field.handleChange}
												onSubmitEditing={() => {
													passwordInputRef.current?.focus();
												}}
												placeholder="email@example.com"
												returnKeyType="next"
												textContentType="emailAddress"
												value={field.state.value}
											/>
										</TextField>
									)}
								</form.Field>

								<form.Field name="password">
									{(field) => (
										<TextField>
											<Label>Password</Label>
											<Input
												autoComplete="password"
												onBlur={field.handleBlur}
												onChangeText={field.handleChange}
												onSubmitEditing={form.handleSubmit}
												placeholder="••••••••"
												ref={passwordInputRef}
												returnKeyType="go"
												secureTextEntry
												textContentType="password"
												value={field.state.value}
											/>
										</TextField>
									)}
								</form.Field>

								<Button
									className="mt-1"
									isDisabled={isSubmitting}
									onPress={form.handleSubmit}
								>
									{isSubmitting ? (
										<Spinner color="default" size="sm" />
									) : (
										<Button.Label>Sign In</Button.Label>
									)}
								</Button>
							</View>
						</>
					);
				}}
			</form.Subscribe>
		</Surface>
	);
}

export { SignIn };

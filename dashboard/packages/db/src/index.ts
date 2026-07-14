import { env } from "@dashboard/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import {
	account,
	accountRelations,
	session,
	sessionRelations,
	user,
	userRelations,
	verification,
} from "./schema/auth";

const schema = {
	account,
	accountRelations,
	session,
	sessionRelations,
	user,
	userRelations,
	verification,
};

export function createDb() {
	return drizzle(env.DATABASE_URL, { schema });
}

export const db = createDb();

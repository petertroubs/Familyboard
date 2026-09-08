import { config } from '../config.ts';
import { openDatabase } from './index.ts';

const db = openDatabase();
console.info(`Migrations appliquées sur ${config.databasePath}`);
db.close();

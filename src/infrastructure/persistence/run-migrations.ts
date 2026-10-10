import { AppDataSource } from './data-source.js';

async function run() {
  console.log('Iniciando execução de migrations TypeORM...');
  try {
    await AppDataSource.initialize();
    const migrations = await AppDataSource.runMigrations();
    console.log(`Migrations executadas com sucesso: ${migrations.length}`);
    for (const m of migrations) {
      console.log(` - ${m.name}`);
    }
  } catch (error) {
    console.error('Erro ao executar migrations:', error);
    process.exit(1);
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

if (import.meta.main) {
  run();
}

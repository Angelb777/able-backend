require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../api/models/User');
const { normalizeNickname, validateNickname } = require('../api/utils/nickname');

function buildMigrationPlan(users) {
  const normalizedOwners = new Map();
  const pendingOnboarding = [];
  const normalize = [];
  const conflicts = [];
  const invalid = [];

  for (const user of users) {
    const id = String(user._id);
    const nickname = typeof user.nickname === 'string' ? user.nickname.trim() : '';
    if (!nickname) {
      pendingOnboarding.push({ id, action: 'onboarding-required' });
      continue;
    }
    const checked = validateNickname(nickname);
    if (!checked.ok) {
      invalid.push({ id, nickname, error: checked.error });
      continue;
    }
    const key = checked.normalizedNickname;
    const previousOwner = normalizedOwners.get(key);
    if (previousOwner) {
      conflicts.push({ normalizedNickname: key, userIds: [previousOwner, id] });
    } else {
      normalizedOwners.set(key, id);
    }
    if (!user.normalizedNickname) {
      normalize.push({ id, nickname, normalizedNickname: key });
    } else if (user.normalizedNickname !== key) {
      invalid.push({
        id,
        nickname,
        error: `normalizedNickname no coincide: ${user.normalizedNickname}`,
      });
    }
  }

  const conflictedIds = new Set(conflicts.flatMap((item) => item.userIds));
  return {
    pendingOnboarding,
    normalize: normalize.filter((item) => !conflictedIds.has(item.id)),
    conflicts,
    invalid,
  };
}

async function applyMigrationPlan(plan, UserModel = User) {
  for (const item of plan.normalize) {
    await UserModel.updateOne(
      {
        _id: item.id,
        nickname: item.nickname,
        $or: [
          { normalizedNickname: { $exists: false } },
          { normalizedNickname: null },
          { normalizedNickname: '' },
        ],
      },
      { $set: { normalizedNickname: item.normalizedNickname } }
    );
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });
  const users = await User.find()
    .select('_id nickname normalizedNickname')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  const plan = buildMigrationPlan(users);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', users: users.length, ...plan }, null, 2));

  if (apply) {
    if (plan.conflicts.length || plan.invalid.length) {
      throw new Error('Migración detenida: resuelve los conflictos o nicknames inválidos antes de aplicar');
    }
    await applyMigrationPlan(plan);
    await User.collection.createIndex(
      { normalizedNickname: 1 },
      {
        unique: true,
        partialFilterExpression: { normalizedNickname: { $type: 'string' } },
        name: 'normalizedNickname_unique_partial',
      }
    );
    console.log(`Normalizados: ${plan.normalize.length}. Pendientes de onboarding: ${plan.pendingOnboarding.length}.`);
  } else {
    console.log('Dry-run: no se ha modificado la base.');
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
}

module.exports = { buildMigrationPlan, applyMigrationPlan };

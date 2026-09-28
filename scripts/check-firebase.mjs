import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signInAnonymously, signOut, deleteUser } from 'firebase/auth';
import { getFirestore, doc, collection, query, where, getDocFromServer, getDocsFromServer, setDoc, deleteDoc, onSnapshot, serverTimestamp, terminate } from 'firebase/firestore';
import { encodeCloudBuilding, decodeCloudBuilding } from '../lib/building-data.mjs';

const config = JSON.parse(await readFile(new URL('../public/runtime-config.json', import.meta.url), 'utf8'));
if (!config.firebase?.projectId || !config.adminEmail) throw new Error('Firebase runtime-config.json ещё не настроен');
if (!process.env.ATLAS_ADMIN_PASSWORD) throw new Error('Требуется переменная ATLAS_ADMIN_PASSWORD');
const suffix = randomUUID(), roadId = `qa-road-${suffix}`, businessId = `qa-draft-${suffix}`, reviewId = `qa-review-${suffix}`, buildingId = `qa-building-${suffix}`;
const adminApp = initializeApp(config.firebase, `qa-admin-${suffix}`), publicApp = initializeApp(config.firebase, `qa-public-${suffix}`);
const adminAuth = getAuth(adminApp), publicAuth = getAuth(publicApp), adminDb = getFirestore(adminApp), publicDb = getFirestore(publicApp);
const adminRoad = doc(adminDb, 'roadEdits', roadId), publicRoad = doc(publicDb, 'roadEdits', roadId), adminBusiness = doc(adminDb, 'businesses', businessId), publicBusiness = doc(publicDb, 'businesses', businessId), adminReview = doc(adminDb, 'reviews', reviewId);
const adminBuilding = doc(adminDb, 'buildingEdits', buildingId), publicBuilding = doc(publicDb, 'buildingEdits', buildingId);
const changes = [];
let stopObserver, anonymousUser, succeeded = false, primaryError;
function timeout(promise, label, duration = 30000) {
  let timer; return Promise.race([promise, new Promise((_,reject) => { timer = setTimeout(() => reject(new Error(`${label}: превышено время ожидания`)), duration); })]).finally(() => clearTimeout(timer));
}
async function denied(promise, label) {
  let error; try { await timeout(promise, label); } catch (cause) { error = cause; }
  assert.equal(error?.code, 'permission-denied', `${label}: ожидался permission-denied, получено ${error?.code || (error ? 'другая ошибка' : 'разрешение')}`);
}
try {
  console.log(`Проверка Firebase ${config.firebase.projectId}: вход и права доступа…`);
  const adminResult = await timeout(signInWithEmailAndPassword(adminAuth, config.adminEmail, process.env.ATLAS_ADMIN_PASSWORD), 'Вход администратора');
  const token = await timeout(adminResult.user.getIdTokenResult(), 'Права администратора');
  assert.ok(token.claims.admin === true || adminResult.user.uid === config.adminUid, 'Учётная запись не имеет роли администратора');
  anonymousUser = (await timeout(signInAnonymously(publicAuth), 'Анонимный тестовый вход')).user;
  assert.equal(anonymousUser.isAnonymous, true);
  changes.push(adminRoad);
  await denied(setDoc(publicRoad, { roadId, name: 'Запрещённая запись QA', asphalt: 1, updatedAt: Date.now() }), 'Анонимная запись дороги');
  await denied(getDocsFromServer(query(collection(publicDb, 'reviews'), where('status', '==', 'pending'))), 'Чтение ожидающих модерации отзывов');
  const draft = { id: businessId, name: 'QA: временный закрытый черновик', lat: 40.66, lon: 70.36, category: 'other', info: 'Только автоматическая проверка. Не публикуется.', phone: '', email: '', website: '', address: '', hours: '', menu: [], published: false, reviewsEnabled: false, updatedAt: Date.now() };
  changes.push(adminBusiness);
  await timeout(setDoc(adminBusiness, draft), 'Создание закрытого черновика');
  assert.equal((await timeout(getDocFromServer(adminBusiness), 'Чтение черновика администратором')).data().published, false);
  await denied(getDocFromServer(publicBusiness), 'Публичное чтение черновика');
  changes.push(adminReview);
  await denied(setDoc(doc(publicDb, 'reviews', reviewId), { id: reviewId, businessId, name: 'QA', text: 'Этот отзыв должен быть отклонён правилами.', rating: 5, status: 'pending', authorUid: anonymousUser.uid, createdAt: serverTimestamp() }), 'Отзыв для неопубликованного места с отключёнными отзывами');
  const building = { id: buildingId, name: 'QA: временная проверка контура', source: 'admin', height: 3, geometry: { type: 'Polygon', coordinates: [[[70.33,40.62],[70.33001,40.62],[70.33001,40.62001],[70.33,40.62]]] } };
  const cloudBuilding = encodeCloudBuilding(building);
  changes.push(adminBuilding);
  await denied(setDoc(publicBuilding, cloudBuilding), 'Анонимная запись здания');
  await denied(setDoc(adminBuilding, { ...cloudBuilding, geometry: { type: 'Polygon', coordinatesJson: '<script>invalid</script>' } }), 'Недопустимая сериализация контура');
  await timeout(setDoc(adminBuilding, cloudBuilding), 'Сохранение облачного контура здания');
  const privateBuildingData = (await timeout(getDocFromServer(adminBuilding), 'Чтение здания администратором')).data();
  assert.equal(typeof privateBuildingData.geometry.coordinatesJson, 'string');
  assert.equal('coordinates' in privateBuildingData.geometry, false);
  assert.deepEqual(decodeCloudBuilding(privateBuildingData).geometry, building.geometry);
  const publicBuildingData = (await timeout(getDocFromServer(publicBuilding), 'Публичное чтение здания')).data();
  assert.deepEqual(decodeCloudBuilding(publicBuildingData).geometry, building.geometry);
  assert.equal(decodeCloudBuilding(publicBuildingData).height, 3);
  console.log('Права проверены. Проверка синхронизации двух клиентов…');
  const expectedName = 'QA: временная проверка синхронизации';
  const observed = new Promise((resolve, reject) => { stopObserver = onSnapshot(publicRoad, snap => { if (!snap.metadata.fromCache && snap.exists() && snap.data().name === expectedName) resolve(snap.data()); }, reject); });
  observed.catch(() => {});
  await timeout(setDoc(adminRoad, { roadId, name: expectedName, asphalt: 2, updatedAt: Date.now() }), 'Запись тестового изменения');
  const observedRoad = await timeout(observed, 'Получение изменения вторым клиентом');
  assert.equal(observedRoad.asphalt, 2);
  assert.equal((await timeout(getDocFromServer(publicRoad), 'Публичное чтение обновления')).data().name, expectedName);
  succeeded = true;
} catch (error) {
  primaryError = error;
} finally {
  stopObserver?.();
  const cleanupErrors = [];
  for (const reference of changes.reverse()) {
    try { await timeout(deleteDoc(reference), `Удаление ${reference.id}`, 15000); } catch (error) { cleanupErrors.push(`${reference.path}: ${error.code || error.message}`); }
  }
  if (anonymousUser) { try { await timeout(deleteUser(anonymousUser), 'Удаление временного анонимного пользователя', 15000); } catch (error) { cleanupErrors.push(`Анонимная учётная запись ${anonymousUser.uid}: ${error.code || error.message}`); } }
  await Promise.allSettled([signOut(adminAuth), signOut(publicAuth)]);
  await Promise.allSettled([terminate(adminDb), terminate(publicDb)]);
  await Promise.allSettled([deleteApp(adminApp), deleteApp(publicApp)]);
  if (cleanupErrors.length) { console.error('Не удалось завершить очистку QA:', cleanupErrors.join('; ')); process.exitCode = 1; }
  if (primaryError) { console.error('FAIL:', primaryError.code || primaryError.message); process.exitCode = 1; }
  else if (succeeded && !cleanupErrors.length) console.log('PASS: доступ администратора, запрет анонимной записи, закрытые черновики, приватная модерация, запрет отзывов для закрытого места, облачная сериализация и публичное чтение здания, синхронизация двух клиентов. Временные документы и анонимная учётная запись удалены.');
}

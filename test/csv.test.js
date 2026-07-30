'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../src/csv');

test('normaliza numero brasileiro de 12 digitos adicionando o 9', () => {
  assert.equal(csv.normalizePhone('556292287319'), '5562992287319');
  assert.equal(csv.normalizePhone('55 62 99228-7319'), '5562992287319');
  assert.equal(csv.normalizePhone('(62) 99228-7319'), '5562992287319');
  assert.equal(csv.normalizePhone('62992287319'), '5562992287319');
});

test('rejeita numero implausivel', () => {
  assert.equal(csv.isPlausiblePhone('5562992287319'), true);
  assert.equal(csv.isPlausiblePhone('556292287319'), false, '12 digitos BR nao passa cru');
  assert.equal(csv.isPlausiblePhone('5562392287319'), false, 'fixo BR (sem 9) nao passa');
  assert.equal(csv.isPlausiblePhone('123'), false);
  assert.equal(csv.isPlausiblePhone('55009922873199'), false, 'DDD 00 invalido');
});

test('le CSV com cabecalho e detecta colunas', () => {
  const text = 'nome,telefone,cidade\nMaria Silva,62992287319,Goiania\nJoao Souza,(62) 99111-2233,Anapolis\n';
  const { rows, headers, stats } = csv.parse(text);
  assert.deepEqual(headers, ['nome', 'telefone', 'cidade']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].phone, '5562992287319');
  assert.equal(rows[0].fields.__first_name, 'Maria');
  assert.equal(rows[0].fields.cidade, 'Goiania');
  assert.equal(stats.invalid, 0);
});

test('respeita aspas, ponto e virgula e quebra de linha interna', () => {
  const text = 'nome;telefone\n"Silva, Maria";62992287319\n"Souza\nJoao";62991112233\n';
  const { rows } = csv.parse(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields.nome, 'Silva, Maria');
});

test('descarta duplicado e invalido, contando cada caso', () => {
  const text = [
    'nome,telefone',
    'A,62992287319',
    'B,62992287319',
    'C,556292287319',
    'D,abc',
    'E,62991112233',
  ].join('\n');
  const { rows, stats } = csv.parse(text);
  assert.equal(rows.length, 2, 'sobram A e E');
  assert.equal(stats.duplicate, 2, 'B duplica A; C normalizado tambem vira A');
  assert.equal(stats.invalid, 1);
});

test('planilha sem cabecalho e tratada como dado', () => {
  const text = '62992287319,Maria\n62991112233,Joao\n';
  const { rows, headers } = csv.parse(text);
  assert.equal(headers[0], 'col1');
  assert.equal(rows.length, 2);
});

test('acha o telefone mesmo sem coluna reconhecivel', () => {
  const text = 'id,contato_principal,obs\n1,62992287319,teste\n';
  const { rows } = csv.parse(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, '5562992287319');
});

test('resolve variaveis do template', () => {
  const row = { phone: '5562992287319', fields: { nome: 'Maria Silva', __first_name: 'Maria', cidade: 'Goiania' } };
  const vars = csv.resolveVariables(
    {
      1: { type: 'firstName', fallback: 'tudo bem' },
      2: { type: 'column', value: 'cidade' },
      3: { type: 'text', value: 'confirmar' },
    },
    row
  );
  assert.deepEqual(vars, ['Maria', 'Goiania', 'confirmar']);
});

test('variavel vazia vira "-" (a Meta rejeita vazio)', () => {
  const row = { phone: '5562992287319', fields: {} };
  const vars = csv.resolveVariables({ 1: { type: 'column', value: 'inexistente' } }, row);
  assert.deepEqual(vars, ['-']);
});

test('primeiro nome e capitalizado e limpo', () => {
  assert.equal(csv.firstName('MARIA DAS DORES'), 'Maria');
  assert.equal(csv.firstName('  joão  silva '), 'João');
  assert.equal(csv.firstName('X'), '', 'nome de 1 letra e descartado');
});

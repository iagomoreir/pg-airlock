CREATE TABLE customers (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  email text NOT NULL,
  plan  text NOT NULL DEFAULT 'free'
);

INSERT INTO customers (name, email, plan) VALUES
  ('Ana',   'ana@example.com',   'pro'),
  ('Bruno', 'bruno@example.com', 'free'),
  ('Carla', 'carla@example.com', 'pro'),
  ('Diego', 'diego@example.com', 'free');

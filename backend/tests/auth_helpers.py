"""Real account sessions for integration tests; all stores live in tmp_path."""
from backend.storage import StoreError


def register_for_test(client, email, password):
    _, code = client.app.state.accounts.issue_code(email, 'register')
    return client.post('/api/auth/register', json={'email':email, 'password':password, 'code':code})


def sign_in(client, email='test@example.com', password='ResearchTests2026'):
    client.headers['X-LexiVault-Token'] = client.get('/api/session').json()['token']
    try:
        registration = register_for_test(client, email, password)
    except StoreError as error:
        assert error.details.get('code') == 'emailExists', error.message
    else:
        assert registration.status_code == 201, registration.text
    response = client.post('/api/auth/login', json={'email':email,'password':password})
    assert response.status_code == 200, response.text
    state = response.json()
    client.headers['X-Account-CSRF'] = state['csrf_token']
    client.headers['X-LexiVault-User'] = state['user']['id']
    return state['user']
